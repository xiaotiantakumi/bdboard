import { postTicketComment, startTicketRun } from '../../../api';
import { AGENT_RUN_POLL_INTERVAL_MS, describeRunStartError } from '../../agentRunShared';
import {
  NEXT_UP_LOOP_COMMENT_POST_TIMEOUT_MS,
  NEXT_UP_LOOP_MAX_CONSECUTIVE_FAILURES,
  buildConsecutiveFailureComment,
  describeConsecutiveFailureStop,
} from './failureMessages';
import {
  delayUnlessStopped,
  describePollFailureError,
  waitForAgentRunTerminal,
} from './polling';
import type {
  NextUpLoopEndReason,
  NextUpLoopProgress,
  TicketRunsChangedListener,
} from './types';

export async function runNextUpTicketLoop(options: {
  ticketIds: readonly string[];
  isStopRequested: () => boolean;
  onProgress: (progress: NextUpLoopProgress) => void;
  postComment?: (ticketId: string, text: string) => Promise<void>;
  /**
   * 開始要求の結果が出た時 (成功・失敗とも) と、実行が終端状態 (succeeded / failed /
   * cancelled) に達した時に呼ぶ。
   */
  onTicketRunsChanged?: TicketRunsChangedListener;
}): Promise<NextUpLoopProgress> {
  const {
    ticketIds,
    isStopRequested,
    onProgress,
    postComment = postTicketComment,
    onTicketRunsChanged,
  } = options;
  // 通知は表示側のキャッシュ更新にすぎないので、失敗してもバッチの進行には影響させない。
  const notifyTicketRunsChanged = (ticketId: string): void => {
    if (onTicketRunsChanged === undefined) {
      return;
    }
    try {
      onTicketRunsChanged(ticketId);
    } catch (notifyError) {
      console.error('Failed to notify ticket runs change', notifyError);
    }
  };
  const progress: NextUpLoopProgress = {
    currentTicketId: null,
    completedCount: 0,
    failedCount: 0,
    cancelledCount: 0,
    unknownCount: 0,
    totalCount: ticketIds.length,
    lastFailureReason: null,
    endReason: null,
  };
  // Every emission is a fresh copy. `progress` below is a single mutable
  // accumulator that the loop keeps writing to, so handing the object itself to
  // a subscriber would put a live pointer into React state and let later
  // iterations rewrite a value the caller already received (bdboard-54be.6).
  onProgress({ ...progress });

  let preserveCurrentTicketId = false;
  let endReason: NextUpLoopEndReason = 'completed';
  let consecutiveFailureCount = 0;
  const consecutiveFailedTicketIds: string[] = [];

  const resetConsecutiveFailures = (): void => {
    consecutiveFailureCount = 0;
    consecutiveFailedTicketIds.length = 0;
    // lastFailureReason は意図的に残す (pkr6.12 の m6.2 却下 / pkr6.17 の議長裁定)。
    // 失敗文言にはチケット ID が入っているので、fail → success で完走したバッチでも
    // 「どのチケットがなぜ失敗したか」を最後まで読めるようにしておく。
  };

  const tryStopOnConsecutiveFailures = async (
    ticketId: string,
    failureReason: string,
  ): Promise<boolean> => {
    consecutiveFailureCount += 1;
    consecutiveFailedTicketIds.push(ticketId);

    if (consecutiveFailureCount < NEXT_UP_LOOP_MAX_CONSECUTIVE_FAILURES) {
      progress.lastFailureReason = failureReason;
      return false;
    }

    progress.lastFailureReason = describeConsecutiveFailureStop(failureReason);
    progress.currentTicketId = null;
    endReason = 'consecutive_failures';
    // Emit before posting the comment: postTicketComment/fetchJson has no timeout and no
    // AbortSignal, so a hung POST would otherwise delay this final emission by up to
    // NEXT_UP_LOOP_COMMENT_POST_TIMEOUT_MS.
    onProgress({ ...progress });
    try {
      // Bound the wait with Promise.race rather than an AbortSignal: postComment is an
      // injected (ticketId, text) => Promise<void>, and threading a signal would mean
      // changing that contract plus postTicketComment/fetchJson, neither of which takes one.
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_resolve, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(
            new Error(
              `comment post timed out after ${NEXT_UP_LOOP_COMMENT_POST_TIMEOUT_MS}ms`,
            ),
          );
        }, NEXT_UP_LOOP_COMMENT_POST_TIMEOUT_MS);
      });
      try {
        await Promise.race([
          postComment(
            ticketId,
            buildConsecutiveFailureComment(
              consecutiveFailedTicketIds,
              failureReason,
            ),
          ),
          timeout,
        ]);
      } finally {
        clearTimeout(timeoutHandle);
      }
    } catch (commentError) {
      // Batch stop must not depend on comment delivery — progress/endReason is the contract,
      // and the stop was already emitted above. Surface the delivery failure in
      // lastFailureReason so the final emission tells the user the ticket has no comment.
      // Timeouts merge here too — same user-visible outcome as a rejected post.
      console.error('Failed to post consecutive-failure comment', commentError);
      progress.lastFailureReason = `${progress.lastFailureReason ?? ''}（チケットへのコメント投稿に失敗しました）`;
    }
    return true;
  };

  for (const ticketId of ticketIds) {
    if (isStopRequested()) {
      endReason = 'stopped';
      break;
    }

    progress.currentTicketId = ticketId;
    onProgress({ ...progress });

    let runId: string;
    try {
      const response = await startTicketRun(ticketId);
      runId = response.runId;
    } catch (error) {
      // 開始に失敗しても、サーバーは worktree の用意などで失敗した実行を failed として
      // 記録していることがある (runStore.start が provision より前に走るため)。
      notifyTicketRunsChanged(ticketId);
      progress.failedCount += 1;
      const failureReason = describeRunStartError(error);
      progress.currentTicketId = null;
      if (await tryStopOnConsecutiveFailures(ticketId, failureReason)) {
        break;
      }
      onProgress({ ...progress });
      if (await delayUnlessStopped(AGENT_RUN_POLL_INTERVAL_MS, isStopRequested)) {
        endReason = 'stopped';
        break;
      }
      continue;
    }

    notifyTicketRunsChanged(ticketId);

    const { outcome, lastPollError } = await waitForAgentRunTerminal(
      runId,
      isStopRequested,
    );

    if (outcome === 'stopped') {
      endReason = 'stopped';
      preserveCurrentTicketId = true;
      onProgress({ ...progress });
      break;
    }
    if (outcome === 'poll_failed') {
      endReason = 'poll_failed';
      progress.unknownCount += 1;
      progress.lastFailureReason = describePollFailureError(lastPollError);
      preserveCurrentTicketId = true;
      onProgress({ ...progress });
      break;
    }

    // ここに来るのは終端状態 (succeeded / failed / cancelled) だけ。stopped と poll_failed は
    // 実行の状態が変わったと言えないので通知しない。
    notifyTicketRunsChanged(ticketId);
    progress.currentTicketId = null;
    if (outcome === 'succeeded') {
      progress.completedCount += 1;
      resetConsecutiveFailures();
      onProgress({ ...progress });
    } else if (outcome === 'cancelled') {
      progress.cancelledCount += 1;
      // Manual cancellation is not a harness failure signal — leave the streak counter unchanged.
      onProgress({ ...progress });
    } else {
      progress.failedCount += 1;
      const failureReason = `エージェント実行が失敗しました（${ticketId}）`;
      if (await tryStopOnConsecutiveFailures(ticketId, failureReason)) {
        break;
      }
      onProgress({ ...progress });
    }
  }

  if (!preserveCurrentTicketId) {
    progress.currentTicketId = null;
  }
  progress.endReason = endReason;
  onProgress({ ...progress });
  // Copy for the same reason as the emissions above. No current caller stores
  // this value, but it is the exported return type, so leaking the accumulator
  // here would reintroduce the hazard the moment one does.
  return { ...progress };
}
