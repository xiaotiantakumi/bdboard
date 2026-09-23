import type { LeftoverCandidate } from '../git-worktree.js';
import { hasLiveWorktreeEvidence } from '../hygiene.js';
import type { Ticket } from '../ticket.js';
import type { TicketId } from '../ticket-id.js';
import { isInRange } from './shared.js';
import {
  RECLAIM_RECLAIM_WINDOW_MS,
  type HarnessKpiRange,
  type ReclaimKpi,
  type ReclaimRunRecord,
} from './types.js';

/**
 * projectId と ticketId の連結キー。区切りは NUL (どちらの値にも現れない) を
 * `\u0000` のエスケープ表記で書く — 生のバイトを書くとファイル全体が git に
 * バイナリ扱いされ、差分が読めなくなる。
 */
function ticketKey(projectId: string, ticketId: TicketId): string {
  return `${projectId}\u0000${ticketId}`;
}

export function computeReclaimKpi(
  reclaimRuns: readonly ReclaimRunRecord[],
  tickets: readonly Ticket[],
  range: HarnessKpiRange,
  windowMs: number = RECLAIM_RECLAIM_WINDOW_MS,
  leftoverCandidates: readonly LeftoverCandidate[] = [],
): ReclaimKpi {
  const ticketIndex = new Map<string, Ticket>();
  for (const ticket of tickets) {
    ticketIndex.set(ticketKey(ticket.projectId, ticket.id), ticket);
  }

  // 「いま」worktree かブランチが残っている (projectId, ticketId) の集合。
  // hasLiveWorktreeEvidence は checkReclaimedLiveWorktree (bdboard-rkde) と同じ述語
  // なので、生存判定を2箇所で別々に実装しない (このファイル冒頭の import 参照)。
  const liveWorktreeTicketKeys = new Set<string>();
  for (const candidate of leftoverCandidates) {
    if (hasLiveWorktreeEvidence(candidate)) {
      liveWorktreeTicketKeys.add(ticketKey(candidate.projectId, candidate.ticketId));
    }
  }

  let runCount = 0;
  let reclaimedCountTotal = 0;
  let unknownCountRunCount = 0;
  let identifiedTicketCount = 0;
  let reclaimedThenInProgressCount = 0;
  let reclaimedLiveWorktreeCount = 0;

  for (const run of reclaimRuns) {
    if (!isInRange(run.at, range)) {
      continue;
    }

    runCount += 1;
    if (run.reclaimedCount === null) {
      unknownCountRunCount += 1;
    } else {
      reclaimedCountTotal += run.reclaimedCount;
    }

    const seen = new Set<TicketId>();
    for (const ticketId of run.ticketIds) {
      if (seen.has(ticketId)) {
        continue;
      }
      seen.add(ticketId);

      // stdout から拾った ID は誤検出を含みうる。板面のチケットに紐付いたものだけを
      // 率の母数にすることで、拾い損ね/拾いすぎが率を歪めないようにしている。
      const ticket = ticketIndex.get(ticketKey(run.projectId, ticketId));
      if (ticket === undefined) {
        continue;
      }

      identifiedTicketCount += 1;

      // open ゲート: checkReclaimedLiveWorktree (hygiene.ts) と同じく in_progress
      // (再 claim 済み) は対象外にする。bdboard-6aci 以降 reclaim は生存証拠の無い
      // チケットしか回収しないので、ゲート無しだと「回収後に別セッションが
      // 再 claim して worktree を作った」正常系まで誤回収として数えてしまう
      // (bdboard-t3ct M1)。
      if (
        ticket.status === 'open' &&
        liveWorktreeTicketKeys.has(ticketKey(run.projectId, ticketId))
      ) {
        reclaimedLiveWorktreeCount += 1;
      }

      // 再 claim は startedAt (bd の started_at = in_progress になった時刻) で判定する。
      // startedAt は「最後に in_progress になった時刻」の**現在値**しか無く、履歴では
      // ないので、これは厳密な再 claim 検出ではなく代理指標 (UI にもその旨を注記する)。
      const startedAt = ticket.startedAt;
      if (startedAt === undefined) {
        continue;
      }
      const delta = startedAt.getTime() - run.at.getTime();
      if (delta > 0 && delta <= windowMs) {
        reclaimedThenInProgressCount += 1;
      }
    }
  }

  return {
    runCount,
    reclaimedCountTotal,
    unknownCountRunCount,
    identifiedTicketCount,
    reclaimedThenInProgressCount,
    reclaimedThenInProgressRate:
      identifiedTicketCount > 0
        ? reclaimedThenInProgressCount / identifiedTicketCount
        : null,
    reclaimedLiveWorktreeCount,
    reclaimedLiveWorktreeRate:
      identifiedTicketCount > 0 ? reclaimedLiveWorktreeCount / identifiedTicketCount : null,
    windowMs,
  };
}
