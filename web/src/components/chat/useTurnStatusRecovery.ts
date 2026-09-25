import { useCallback, useEffect, useState, type MutableRefObject } from 'react';
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
 * chat/useChatHistoryLoader.ts(旧 E12/E13)より前)。historyRequestIdRef /
 * threadListRequestIdRef を進めるのは hydrate するときだけ(以前は generation>0 で
 * 張り直すたびに先頭で進めていた。bdboard-x4mv / bdboard-ibkf)。どちらも hydrate の
 * fetch の後、当てる直前に進める(一覧は bdboard-tsen、履歴は bdboard-lsv2)。
 * 「応答から何をすべきか決める」部分は chat/turnStatusStep.ts の
 * decideTurnStatusStep へ切り出し、ここには ACK・hydrate の fetch・setState・
 * ポーリングのタイマー/バックオフだけが残る。
 *
 * detachedSendsRef(旧 detachedStreamSendRef)と turnRecoveryGeneration は
 * chat/useChatSendState.ts (第13a段) の useReducer が持つ。送信/ストリーム側
 * (第13b段で chat/useChatSubmit.ts・chat/deliverChatSend.ts へ移った)も直接読み書きするため、
 * この effect の内側だけでは完結しない。
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
    // generation は「この effect を張り直す」ためだけの依存(同じプロジェクト内の
    // スレッド切替による abort では selectedProjectId が変わらないため)。張り直しの
    // 時点では history / スレッド一覧の request-id を進めない。
    // - bdboard-x4mv: 一覧の id を進めると、プロジェクト切替で始まった
    //   useThreadListSync(E7)の一覧 fetch を無効化してしまう — 切替による abort
    //   から少し遅れて generation が進んだとき、そして generation は減らないので、
    //   一度 bump された後の切替では毎回(同じコミットで E7 → この effect の順に走る)。
    // - bdboard-ibkf: 履歴の id を進めると、ストリーム中に切り替えた先の未読込
    //   スレッドの履歴 fetch(useChatHistoryLoader、E12)が遅れて届く bump で無効化
    //   され、historyLoadedFor が立たないまま E12 も再実行されず、送信ボタンが
    //   無効のまま戻らなかった。
    // この effect は hydrate しない限り一覧も履歴も取り直さない。古い応答が回収結果を
    // 上書きしないためのガードは、下の hydrate 分岐が当てる直前に進める request-id が
    // 担う(一覧は bdboard-tsen、履歴は bdboard-lsv2。hydrate が成功しないなら守るべき
    // 回収結果も無い)。
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
        // bdboard-tsen: スレッド一覧の request-id は fetch の前ではなく、当てる直前に進める。
        // fetch の前に進めると、その間に届いた useThreadListSync(E7)の一覧応答が捨てられ、
        // E7 だけが担う永続化済み open/選択の復元とチケット起動の pending ドラフトの消化が
        // 失われた。ここで控えた id が当てる時点まで変わっていなければ(より新しい一覧
        // fetch が始まっていなければ)当てる。履歴の request-id も同じく当てる直前に進める
        // (bdboard-lsv2、下の apply 直前のコメント)。
        const listRequestIdAtStart = threadListRequestIdRef.current;
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
        if (cancelled || listRequestIdAtStart !== threadListRequestIdRef.current) return;
        // まだ届いていない E7 の応答は、ここから先は一覧・open・選択を当てない
        // (pending ドラフトの消化だけ行う)。
        threadListRequestIdRef.current += 1;
        // A detached turn can create a session whose id was unknown when the tab
        // closed. Invalidate older history requests right before hydrating the
        // server-owned result so a late response cannot overwrite the recovered state.
        // bdboard-lsv2: 以前は fetch の前に進めていたため、hydrate の fetch が失敗し
        // 続けると(または張り直しで打ち切られると)、その間に useChatHistoryLoader(E12)
        // が読み込んでいた別スレッドの履歴応答と historyLoadedFor の書き込みが捨てられた
        // まま conversations も変わらず、送信ボタンが無効のまま戻らなかった。ここで
        // 進めても、回収したセッション自身の E12/E13 の応答は、それより前に届けば
        // applyRecoveredTurn が上書きし、後に届けば捨てられるので、回収結果の保護は
        // 変わらない。他のスレッドの応答は、それより前に届いたものはそのまま残る。
        historyRequestIdRef.current += 1;
        setLoadingHistoryFor(null);
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

  // bdboard-sso1.83 第13b段: submit(chat/useChatSubmit.ts)の useCallback deps に入るので
  // 参照を安定させる(setBackgroundTurnStatus は useState の setter で安定)。
  const resetBackgroundTurnStatus = useCallback(() => setBackgroundTurnStatus({ state: 'idle' }), []);

  return { backgroundTurnStatus, backgroundTurnProjectId, resetBackgroundTurnStatus };
}
