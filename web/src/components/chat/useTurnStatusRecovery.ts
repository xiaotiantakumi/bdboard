import { useEffect, useState, type MutableRefObject } from 'react';
import {
  acknowledgeChatTurn,
  fetchChatSessionMessages,
  fetchChatThreads,
  fetchChatTurnStatus,
  type ChatSessionMessagesDto,
  type ChatThreadDto,
  type ChatTurnStatusDto,
} from '../../api';
import { TURN_STATUS_POLL_RETRY_BACKOFF_MS } from './turnStatusPolicy';
import { decideTurnStatusStep } from './turnStatusStep';

export interface DetachedTurnSend {
  sessionId: string | undefined;
  streamingKey: string;
  detachedAt: number;
  fail: () => void;
}

export interface UseTurnStatusRecoveryResult {
  backgroundTurnStatus: ChatTurnStatusDto;
  backgroundTurnProjectId: string;
  resetBackgroundTurnStatus: () => void;
}

/**
 * bdboard-sso1.83 第12段: ChatPanel.tsx の旧 E8(turn-status 回収 effect)を
 * move+分割で抜き出したもの。呼び出し位置は元の E8 の位置のまま(E7 より後、
 * chat/useChatHistoryLoader.ts(旧 E12/E13)より前 — generation>0 のときに
 * historyRequestIdRef/threadListRequestIdRef を bump する順序を守る必要がある)。
 * 「応答から何をすべきか決める」部分は chat/turnStatusStep.ts の
 * decideTurnStatusStep へ切り出し、ここには ACK・hydrate の fetch・setState・
 * ポーリングのタイマー/バックオフだけが残る。
 *
 * detachedSendsRef(旧 detachedStreamSendRef)と turnRecoveryGeneration の
 * useState 自体は ChatPanel.tsx 側に残る — 送信/ストリーム側(第13段の対象)も
 * 直接読み書きするため、この effect の内側だけでは完結しないため。
 */
export function useTurnStatusRecovery(params: {
  selectedProjectId: string;
  generation: number;
  detachedSendsRef: MutableRefObject<Record<string, DetachedTurnSend>>;
  historyRequestIdRef: MutableRefObject<number>;
  threadListRequestIdRef: MutableRefObject<number>;
  setLoadingHistoryFor: (value: string | null) => void;
  clearStreamingReplyForKey: (key: string) => void;
  clearUnresolvedSend: (sessionId: string) => void;
  applyRecoveredTurn: (threads: ChatThreadDto[], payload: ChatSessionMessagesDto) => void;
}): UseTurnStatusRecoveryResult {
  const {
    selectedProjectId,
    generation,
    detachedSendsRef,
    historyRequestIdRef,
    threadListRequestIdRef,
    setLoadingHistoryFor,
    clearStreamingReplyForKey,
    clearUnresolvedSend,
    applyRecoveredTurn,
  } = params;

  const [backgroundTurnStatus, setBackgroundTurnStatus] = useState<ChatTurnStatusDto>({ state: 'idle' });
  const [backgroundTurnProjectId, setBackgroundTurnProjectId] = useState('');

  useEffect(() => {
    if (selectedProjectId === '') return;
    let cancelled = false;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    if (generation > 0) {
      historyRequestIdRef.current += 1;
      threadListRequestIdRef.current += 1;
      setLoadingHistoryFor(null);
    }
    setBackgroundTurnProjectId(selectedProjectId);
    setBackgroundTurnStatus({ state: 'idle' });
    const recoveredSessionIds = new Set<string>();
    const drainedFailedSessionIds = new Set<string>();
    let consecutiveFailures = 0;
    let unmatchedSessionlessFailedStreak = 0;

    const checkTurnStatus = async (): Promise<void> => {
      try {
        const status = await fetchChatTurnStatus(selectedProjectId);
        if (cancelled) return;
        consecutiveFailures = 0;
        setBackgroundTurnStatus(status);

        const detachedEntry = detachedSendsRef.current[selectedProjectId];
        const step = decideTurnStatusStep({
          status,
          detached:
            detachedEntry === undefined
              ? undefined
              : { sessionId: detachedEntry.sessionId, detachedAt: detachedEntry.detachedAt },
          isRecoveredCompletedSession:
            status.state === 'completed' && recoveredSessionIds.has(status.sessionId),
          isDrainedFailedSession:
            status.state === 'failed' &&
            status.sessionId !== undefined &&
            drainedFailedSessionIds.has(status.sessionId),
          unmatchedSessionlessFailedStreak,
        });
        unmatchedSessionlessFailedStreak = step.nextUnmatchedSessionlessFailedStreak;

        if (step.kind === 'done') return;

        if (step.kind === 'fail-detached') {
          if (step.ackSessionId !== undefined) {
            try {
              await acknowledgeChatTurn(selectedProjectId, step.ackSessionId);
            } catch {
              // ACK is best-effort; a later poll can just see the same failed turn again.
            }
            if (cancelled) return;
          }
          const detached = detachedSendsRef.current[selectedProjectId];
          if (detached !== undefined) {
            delete detachedSendsRef.current[selectedProjectId];
            clearStreamingReplyForKey(detached.streamingKey);
            detached.fail();
          }
          return;
        }

        if (step.kind === 'poll-later') {
          pollTimer = setTimeout(() => {
            void checkTurnStatus();
          }, step.delayMs);
          return;
        }

        if (step.kind === 'ack-and-recheck') {
          drainedFailedSessionIds.add(step.sessionId);
          try {
            await acknowledgeChatTurn(selectedProjectId, step.sessionId);
          } catch {
            // best-effort; the dedup guard above stops a tight loop either way.
          }
          if (cancelled) return;
          await checkTurnStatus();
          return;
        }

        // step.kind === 'hydrate'
        recoveredSessionIds.add(step.sessionId);
        // A detached turn can create a session whose id was unknown when the tab
        // closed. Invalidate older history/thread-list requests before hydrating
        // the server-owned result so a late initial response cannot overwrite the
        // recovered state.
        historyRequestIdRef.current += 1;
        setLoadingHistoryFor(null);
        const recoveryThreadRequestId = ++threadListRequestIdRef.current;
        let threads: ChatThreadDto[];
        let payload: ChatSessionMessagesDto;
        try {
          [threads, payload] = await Promise.all([
            fetchChatThreads(selectedProjectId),
            fetchChatSessionMessages(step.sessionId, selectedProjectId),
          ]);
        } catch (hydrationError) {
          // bdboard-3tw.164: this failure is the fetch itself, not "the same
          // completed turn seen again" - clear the dedup mark so a retry can hydrate.
          recoveredSessionIds.delete(step.sessionId);
          throw hydrationError;
        }
        if (cancelled || recoveryThreadRequestId !== threadListRequestIdRef.current) return;
        applyRecoveredTurn(threads, payload);
        if (step.detachedMatchesThisRecovery) {
          const matched = detachedSendsRef.current[selectedProjectId];
          if (matched !== undefined) {
            delete detachedSendsRef.current[selectedProjectId];
            clearStreamingReplyForKey(matched.streamingKey);
          }
        }
        clearUnresolvedSend(step.sessionId);
        try {
          await acknowledgeChatTurn(selectedProjectId, step.sessionId);
        } catch {
          // ACK is best-effort; a later mount can safely hydrate the same persisted turn.
          return;
        }
        if (cancelled) return;
        // Unresolved completions are delivered one at a time; keep draining.
        await checkTurnStatus();
      } catch {
        if (cancelled) return;
        consecutiveFailures += 1;
        const backoffMs = TURN_STATUS_POLL_RETRY_BACKOFF_MS[consecutiveFailures - 1];
        if (backoffMs === undefined) {
          console.warn(
            `chat turn-status polling gave up after ${TURN_STATUS_POLL_RETRY_BACKOFF_MS.length} consecutive failures`,
          );
          setBackgroundTurnStatus((prev) => (prev.state === 'processing' ? { state: 'idle' } : prev));
          const exhaustedDetached = detachedSendsRef.current[selectedProjectId];
          if (exhaustedDetached !== undefined) {
            delete detachedSendsRef.current[selectedProjectId];
            clearStreamingReplyForKey(exhaustedDetached.streamingKey);
            exhaustedDetached.fail();
          }
          return;
        }
        pollTimer = setTimeout(() => {
          void checkTurnStatus();
        }, backoffMs);
      }
    };

    void checkTurnStatus();
    return () => {
      cancelled = true;
      if (pollTimer !== undefined) clearTimeout(pollTimer);
    };
  }, [
    selectedProjectId,
    generation,
    detachedSendsRef,
    historyRequestIdRef,
    threadListRequestIdRef,
    setLoadingHistoryFor,
    clearStreamingReplyForKey,
    clearUnresolvedSend,
    applyRecoveredTurn,
  ]);

  const resetBackgroundTurnStatus = () => setBackgroundTurnStatus({ state: 'idle' });

  return { backgroundTurnStatus, backgroundTurnProjectId, resetBackgroundTurnStatus };
}
