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
  type TicketAccumulator,
} from './types.js';

/**
 * projectId と ticketId の連結キー。区切りは NUL (どちらの値にも現れない) を
 * `\u0000` のエスケープ表記で書く — 生のバイトを書くとファイル全体が git に
 * バイナリ扱いされ、差分が読めなくなる。
 */
function ticketKey(projectId: string, ticketId: TicketId): string {
  return `${projectId}\u0000${ticketId}`;
}

/**
 * reclaim 指標の集計器 (bdboard-kuui)。computeReclaimKpi の本体で、チケットを 1 件ずつ
 * add できる。
 *
 * 以前は全チケットを (projectId, ticketId) → Ticket の Map に積んでから突き合わせて
 * いたが、突き合わせに使うのは「期間内の reclaim 発火が名指しした ID」だけ。
 * そこで先に発火記録から欲しい ID を (projectId → ticketId → Ticket) の入れ子の Map として
 * 用意し、add は一致したチケットだけを拾う (発火が無ければ add は Map を 1 回引くだけ)。
 * 同じ (projectId, ticketId) が複数回 add されたら最後のものが残る — 以前の
 * 「全チケットを Map.set して後勝ち」と同じ。
 *
 * 期間内の発火と生存証拠のある worktree は生成時に写し取る。add の間に await を挟んで
 * 呼び出し側が reclaimRuns / leftoverCandidates を書き換えても、結果が食い違わない。
 */
export function createReclaimAccumulator(
  reclaimRuns: readonly ReclaimRunRecord[],
  range: HarnessKpiRange,
  windowMs: number = RECLAIM_RECLAIM_WINDOW_MS,
  leftoverCandidates: readonly LeftoverCandidate[] = [],
): TicketAccumulator<ReclaimKpi> {
  const runsInRange = reclaimRuns.filter((run) => isInRange(run.at, range));

  const wantedTickets = new Map<string, Map<TicketId, Ticket | undefined>>();
  for (const run of runsInRange) {
    let slot = wantedTickets.get(run.projectId);
    if (slot === undefined) {
      slot = new Map<TicketId, Ticket | undefined>();
      wantedTickets.set(run.projectId, slot);
    }
    for (const ticketId of run.ticketIds) {
      slot.set(ticketId, undefined);
    }
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

  function finish(): ReclaimKpi {
    let reclaimedCountTotal = 0;
    let unknownCountRunCount = 0;
    let identifiedTicketCount = 0;
    let reclaimedThenInProgressCount = 0;
    let reclaimedLiveWorktreeCount = 0;

    for (const run of runsInRange) {
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
        const ticket = wantedTickets.get(run.projectId)?.get(ticketId);
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
      runCount: runsInRange.length,
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

  return {
    add(ticket: Ticket): void {
      const slot = wantedTickets.get(ticket.projectId);
      if (slot !== undefined && slot.has(ticket.id)) {
        slot.set(ticket.id, ticket);
      }
    },
    finish,
  };
}

export function computeReclaimKpi(
  reclaimRuns: readonly ReclaimRunRecord[],
  tickets: readonly Ticket[],
  range: HarnessKpiRange,
  windowMs: number = RECLAIM_RECLAIM_WINDOW_MS,
  leftoverCandidates: readonly LeftoverCandidate[] = [],
): ReclaimKpi {
  const accumulator = createReclaimAccumulator(reclaimRuns, range, windowMs, leftoverCandidates);
  for (const ticket of tickets) {
    accumulator.add(ticket);
  }
  return accumulator.finish();
}
