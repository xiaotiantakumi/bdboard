import type { LeftoverCandidate } from './git-worktree.js';
import { hasLiveWorktreeEvidence } from './hygiene.js';
import type { Ticket } from './ticket.js';
import type { TicketId } from './ticket-id.js';

/**
 * ハーネス自体の効き目を測る 4 指標 (docs/HARNESS-EVALUATION.md §4.4 / §5 P4)。
 *
 * すべて純粋関数で、入力は「板面キャッシュに載っている Ticket[]」と
 * 「reclaim 実行の記録 (ReclaimRunRecord[])」だけ。新しい永続化は要らない。
 */

/** 確認待ち(awaiting_human)の判定に使う bd ラベル。 */
export const PENDING_DECISION_LABEL = 'human';

/**
 * 確認待ちの判定に使う bd の issue type。
 *
 * gate は await_type (decision / review など) を問わず全部数える。`Ticket` は
 * await_type を保持していないので、そもそもドメイン層では種別を判別できない —
 * 分けたいなら先に Ticket 側へ await_type を写すところから。
 */
export const PENDING_DECISION_ISSUE_TYPE = 'gate';

/** ハーネス起票とみなすラベル。 */
export const HARNESS_LABELS: readonly string[] = ['harness', 'harness-upstream'];

/**
 * 重複/再発チケットの粗い代理指標。title + description に当てる。
 * 単語境界を持たない日本語を含むので誤検出はする — UI 側で「粗い指標」と注記する。
 */
export const DUPLICATE_MENTION_PATTERN = /重複|duplicate|再発|二重|統合/i;

/** 「reclaim 直後の再 claim」とみなす猶予 (30 分)。 */
export const RECLAIM_RECLAIM_WINDOW_MS = 30 * 60_000;

export interface HarnessKpiRange {
  readonly start: Date;
  readonly end: Date;
}

/**
 * reclaim の 1 実行分の記録。application 層のリングバッファが積む。
 *
 * `reclaimedCount` は parse-reclaim-output が stdout から読めた件数 (読めなければ
 * null)、`ticketIds` は同じく stdout から拾えたチケットID。bd の出力形式は保証が
 * 無いので、どちらも「取れたら取る」扱いにしている。
 */
export interface ReclaimRunRecord {
  readonly projectId: string;
  readonly at: Date;
  readonly reclaimedCount: number | null;
  readonly ticketIds: readonly TicketId[];
}

export interface PendingDecisionDwellKpi {
  /**
   * 期間内に**確認待ちのまま close された**チケット数 (中央値/p90 の母数)。
   *
   * bdboard-xgvh 以降、作業チケットへの回答は human ラベルを外すだけで close しない。
   * その結果、回答済みの作業チケットは板面から見て「確認待ちでも未クローズでもない」
   * 状態になり、この母数からも openCount からも消える。gate は回答＝close なので
   * 素直に入る。内訳が読めるよう gate / work を分けて数える。
   */
  readonly closedCount: number;
  /** そのうち issue_type=gate のもの */
  readonly closedGateCount: number;
  /** そのうち human ラベル付きの作業チケット (gate 以外) */
  readonly closedWorkCount: number;
  /** いま未クローズの確認待ちチケット数。**期間で絞らない現在値** */
  readonly openCount: number;
  /** そのうち issue_type=gate のもの */
  readonly openGateCount: number;
  /** そのうち human ラベル付きの作業チケット (gate 以外) */
  readonly openWorkCount: number;
  readonly medianMs: number | null;
  readonly p90Ms: number | null;
  /**
   * 滞留時間の起点。bd からラベル付与時刻が取れないので、いまは常に作成時刻
   * ('created')。UI はこの値を見て「作成時刻で代替」と注記する。
   */
  readonly anchor: 'created';
}

export interface ReclaimKpi {
  /** 期間内に記録された reclaim 発火回数 */
  readonly runCount: number;
  /** そのうち件数が読めた分の合計 */
  readonly reclaimedCountTotal: number;
  /** 件数が読めなかった発火回数 */
  readonly unknownCountRunCount: number;
  /** stdout から拾えて、かつ板面のチケットに紐付いた回収 ID の数 (率の母数) */
  readonly identifiedTicketCount: number;
  /** そのうち windowMs 以内に再び in_progress になった数 */
  readonly reclaimedThenInProgressCount: number;
  /** 誤回収の代理指標。母数 0 なら null */
  readonly reclaimedThenInProgressRate: number | null;
  readonly windowMs: number;
  /**
   * identifiedTicketCount のうち、**現時点で** worktree かブランチが残っている数
   * (bdboard-rkde の `reclaimed_live_worktree` と同じ生存判定 =
   * `hasLiveWorktreeEvidence`)。回収時点の状態そのものではなく「いま見えている
   * 生存証拠」なので、回収後すぐに掃除された誤回収は数え損なう (実測値の下限)。
   */
  readonly reclaimedLiveWorktreeCount: number;
  /** 母数 (identifiedTicketCount) が 0 なら null */
  readonly reclaimedLiveWorktreeRate: number | null;
}

export interface HarnessShareKpi {
  readonly matchedCount: number;
  readonly totalCount: number;
  /** 母数 0 なら null */
  readonly rate: number | null;
}

export interface HarnessKpi {
  readonly rangeStart: Date;
  readonly rangeEnd: Date;
  readonly pendingDecisionDwell: PendingDecisionDwellKpi;
  readonly reclaim: ReclaimKpi;
  readonly harnessLabeled: HarnessShareKpi;
  readonly duplicateMention: HarnessShareKpi;
}

export interface ComputeHarnessKpiInput {
  readonly tickets: readonly Ticket[];
  readonly range: HarnessKpiRange;
  readonly reclaimRuns?: readonly ReclaimRunRecord[];
  readonly reclaimWindowMs?: number;
  /**
   * 誤回収件数 (reclaimedLiveWorktreeCount) の判定材料。git worktree/branch の
   * 現在のスキャン結果 (scanGitLeftovers)。未指定なら 0 になる。
   */
  readonly leftoverCandidates?: readonly LeftoverCandidate[];
}

function isInRange(at: Date, range: HarnessKpiRange): boolean {
  const timestamp = at.getTime();
  return timestamp >= range.start.getTime() && timestamp <= range.end.getTime();
}

export function isPendingDecisionTicket(ticket: Ticket): boolean {
  if (ticket.issueType === PENDING_DECISION_ISSUE_TYPE) {
    return true;
  }
  return ticket.labels?.includes(PENDING_DECISION_LABEL) ?? false;
}

export function hasHarnessLabel(ticket: Ticket): boolean {
  return ticket.labels?.some((label) => HARNESS_LABELS.includes(label)) ?? false;
}

export function mentionsDuplicate(ticket: Ticket): boolean {
  const haystack = `${ticket.title}\n${ticket.description ?? ''}`;
  return DUPLICATE_MENTION_PATTERN.test(haystack);
}

/**
 * 昇順ソート済みの配列に対する分位点 (線形補間、numpy 既定と同じ R-7)。
 * 中央値が偶数件でも「真ん中2つの平均」になるので、median と p90 で計算方式が
 * ぶれない。戻り値はミリ秒として整数に丸める。
 */
export function percentileMs(sortedValues: readonly number[], p: number): number | null {
  if (sortedValues.length === 0) {
    return null;
  }
  const clamped = Math.min(1, Math.max(0, p));
  const rank = (sortedValues.length - 1) * clamped;
  const lowIndex = Math.floor(rank);
  const highIndex = Math.ceil(rank);
  const low = sortedValues[lowIndex];
  const high = sortedValues[highIndex];
  if (low === undefined || high === undefined) {
    return null;
  }
  return Math.round(low + (high - low) * (rank - lowIndex));
}

export function computePendingDecisionDwell(
  tickets: readonly Ticket[],
  range: HarnessKpiRange,
): PendingDecisionDwellKpi {
  const durations: number[] = [];
  let closedGateCount = 0;
  let closedWorkCount = 0;
  let openCount = 0;
  let openGateCount = 0;
  let openWorkCount = 0;

  for (const ticket of tickets) {
    if (!isPendingDecisionTicket(ticket)) {
      continue;
    }
    const isGate = ticket.issueType === PENDING_DECISION_ISSUE_TYPE;

    if (ticket.closedAt === undefined) {
      openCount += 1;
      if (isGate) {
        openGateCount += 1;
      } else {
        openWorkCount += 1;
      }
      continue;
    }

    if (!isInRange(ticket.closedAt, range)) {
      continue;
    }

    if (isGate) {
      closedGateCount += 1;
    } else {
      closedWorkCount += 1;
    }

    // ラベル付与時刻は bd から取れないので作成時刻を起点にする (anchor: 'created')。
    // close が作成より前になることは無いはずだが、時計のずれで負にならないよう 0 で切る。
    durations.push(Math.max(0, ticket.closedAt.getTime() - ticket.createdAt.getTime()));
  }

  durations.sort((a, b) => a - b);

  return {
    closedCount: durations.length,
    closedGateCount,
    closedWorkCount,
    openCount,
    openGateCount,
    openWorkCount,
    medianMs: percentileMs(durations, 0.5),
    p90Ms: percentileMs(durations, 0.9),
    anchor: 'created',
  };
}

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

      if (liveWorktreeTicketKeys.has(ticketKey(run.projectId, ticketId))) {
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

function computeShare(
  tickets: readonly Ticket[],
  range: HarnessKpiRange,
  predicate: (ticket: Ticket) => boolean,
): HarnessShareKpi {
  let matchedCount = 0;
  let totalCount = 0;

  for (const ticket of tickets) {
    if (!isInRange(ticket.createdAt, range)) {
      continue;
    }
    totalCount += 1;
    if (predicate(ticket)) {
      matchedCount += 1;
    }
  }

  return {
    matchedCount,
    totalCount,
    rate: totalCount > 0 ? matchedCount / totalCount : null,
  };
}

export function computeHarnessLabeledShare(
  tickets: readonly Ticket[],
  range: HarnessKpiRange,
): HarnessShareKpi {
  return computeShare(tickets, range, hasHarnessLabel);
}

export function computeDuplicateMentionShare(
  tickets: readonly Ticket[],
  range: HarnessKpiRange,
): HarnessShareKpi {
  return computeShare(tickets, range, mentionsDuplicate);
}

export function computeHarnessKpi(input: ComputeHarnessKpiInput): HarnessKpi {
  const { tickets, range } = input;

  return {
    rangeStart: range.start,
    rangeEnd: range.end,
    pendingDecisionDwell: computePendingDecisionDwell(tickets, range),
    reclaim: computeReclaimKpi(
      input.reclaimRuns ?? [],
      tickets,
      range,
      input.reclaimWindowMs ?? RECLAIM_RECLAIM_WINDOW_MS,
      input.leftoverCandidates ?? [],
    ),
    harnessLabeled: computeHarnessLabeledShare(tickets, range),
    duplicateMention: computeDuplicateMentionShare(tickets, range),
  };
}
