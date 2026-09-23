// bdboard-sso1.79: useTicketAgentRun.ts から、activeRunId のポーリング用
// useEffect (fetchAgentRun を AGENT_RUN_POLL_INTERVAL_MS 間隔で叩き、
// AGENT_RUN_POLL_MAX_FAILURES 回連続失敗したら停止する) を move-only で切り出した
// フック。ロジック本体・ポーリング間隔・停止条件・クリーンアップ・依存配列
// (`[activeRunId, queryClient, ticketId]`) は移動前から変えていない。
// polledRunDetail/runStatusUnavailable の state 自体は親の hasActiveRun 算出
// からも参照されるため親に残し、setter を引数で受け取る。
import type { QueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { fetchAgentRun, type AgentRunDetailDto } from '../../../api';
import {
  AGENT_RUN_POLL_INTERVAL_MS,
  AGENT_RUN_POLL_MAX_FAILURES,
  isAgentRunInProgress,
} from '../../agentRunShared';

export function useAgentRunPolling(
  activeRunId: string | null,
  queryClient: QueryClient,
  ticketId: string,
  setPolledRunDetail: (detail: AgentRunDetailDto | null) => void,
  setRunStatusUnavailable: (unavailable: boolean) => void,
) {
  useEffect(() => {
    if (activeRunId === null) {
      setPolledRunDetail(null);
      setRunStatusUnavailable(false);
      return;
    }

    let cancelled = false;
    let intervalId: ReturnType<typeof setInterval> | undefined;
    let consecutiveFailures = 0;

    setRunStatusUnavailable(false);
    consecutiveFailures = 0;

    const poll = async (): Promise<AgentRunDetailDto | null> => {
      try {
        const detail = await fetchAgentRun(activeRunId);
        if (cancelled) {
          return null;
        }
        consecutiveFailures = 0;
        setRunStatusUnavailable(false);
        setPolledRunDetail(detail);
        if (!isAgentRunInProgress(detail.status)) {
          void queryClient.invalidateQueries({
            queryKey: ['ticket-runs', ticketId],
          });
        }
        return detail;
      } catch (pollError) {
        console.error('Failed to poll agent run', pollError);
        if (cancelled) {
          return null;
        }
        consecutiveFailures += 1;
        if (consecutiveFailures >= AGENT_RUN_POLL_MAX_FAILURES) {
          setRunStatusUnavailable(true);
          if (intervalId !== undefined) {
            clearInterval(intervalId);
            intervalId = undefined;
          }
        }
        return null;
      }
    };

    void (async () => {
      const initialDetail = await poll();
      if (cancelled || consecutiveFailures >= AGENT_RUN_POLL_MAX_FAILURES) {
        return;
      }
      if (
        initialDetail !== null &&
        !isAgentRunInProgress(initialDetail.status)
      ) {
        return;
      }

      intervalId = setInterval(() => {
        void (async () => {
          const detail = await poll();
          if (cancelled || consecutiveFailures >= AGENT_RUN_POLL_MAX_FAILURES) {
            return;
          }
          if (
            detail !== null &&
            !isAgentRunInProgress(detail.status) &&
            intervalId !== undefined
          ) {
            clearInterval(intervalId);
            intervalId = undefined;
          }
        })();
      }, AGENT_RUN_POLL_INTERVAL_MS);
    })();

    return () => {
      cancelled = true;
      if (intervalId !== undefined) {
        clearInterval(intervalId);
      }
    };
  }, [activeRunId, queryClient, ticketId]);
}
