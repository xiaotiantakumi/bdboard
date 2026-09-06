import { getBoardTimeZone } from '../../config/board-timezone.js';
import type { LeftoverCandidate } from '../../domain/git-worktree.js';
import {
  computeHarnessKpi,
  type HarnessKpi,
  type ReclaimRunRecord,
} from '../../domain/harness-kpi.js';
import type { Ticket } from '../../domain/ticket.js';
import type { BoardCache } from '../ports/board-cache.js';
import { buildWeekStarts } from './week-boundary.js';

export interface GetHarnessKpiOptions {
  /** 指定されたIDのみ。未指定なら全部 */
  readonly projectIds?: readonly string[];
  readonly weeks?: number;
  readonly timeZone?: string;
  /** reclaim-history のリングバッファの中身 (無ければ reclaim 指標は空になる) */
  readonly reclaimRuns?: readonly ReclaimRunRecord[];
  /** reclaim 記録を始めた時刻 (= サーバー起動時刻)。永続化しないので UI に注記する */
  readonly reclaimSince?: Date;
  /** 出力を読めず履歴に積めなかった reclaim 実行の回数 */
  readonly reclaimUnparsedRunCount?: number;
  /**
   * 誤回収件数 (reclaimedLiveWorktreeCount) 用の git worktree/branch スキャン結果
   * (scanGitLeftovers)。未指定なら 0 になる (bdboard-t3ct)。
   */
  readonly leftoverCandidates?: readonly LeftoverCandidate[];
  /**
   * leftoverCandidates が git を最後まで読めた完全なスキャン結果かどうか
   * (`scanGitLeftovers().complete`)。省略時は true (bdboard-t3ct 以前の呼び出し元
   * との互換)。false なら DTO 変換 (toHarnessKpiDto) が reclaimedLiveWorktreeCount /
   * Rate を null に上書きする — 「0件」と「読めなかった」を混同しないため
   * (bdboard-t3ct M2)。
   */
  readonly leftoverScanComplete?: boolean;
}

export interface HarnessKpiStats {
  readonly kpi: HarnessKpi;
  readonly reclaimSince: Date | null;
  readonly reclaimUnparsedRunCount: number;
  /** GetHarnessKpiOptions.leftoverScanComplete を参照。 */
  readonly leftoverScanComplete: boolean;
}

const DEFAULT_WEEKS = 8;

function collectTickets(
  cache: BoardCache,
  projectIdFilter?: ReadonlySet<string>,
): readonly Ticket[] {
  let entries = cache.listProjects();
  if (projectIdFilter !== undefined) {
    entries = entries.filter((entry) => projectIdFilter.has(entry.project.id));
  }

  const tickets: Ticket[] = [];
  for (const entry of entries) {
    tickets.push(...entry.tickets);
  }
  return tickets;
}

/**
 * reclaim 実行にもチケットと同じプロジェクト絞り込みを掛ける。ここを通さないと、
 * 「プロジェクト A だけ」を選んでいるのに B の reclaim 発火が発火回数に混ざり、
 * しかも ID 突き合わせは A のチケットとしか行われないので率まで狂う。
 */
function filterReclaimRuns(
  runs: readonly ReclaimRunRecord[],
  projectIdFilter?: ReadonlySet<string>,
): readonly ReclaimRunRecord[] {
  if (projectIdFilter === undefined) {
    return runs;
  }
  return runs.filter((run) => projectIdFilter.has(run.projectId));
}

/** filterReclaimRuns と同じ理由で、leftoverCandidates にも同じ絞り込みを掛ける。 */
function filterLeftoverCandidates(
  candidates: readonly LeftoverCandidate[],
  projectIdFilter?: ReadonlySet<string>,
): readonly LeftoverCandidate[] {
  if (projectIdFilter === undefined) {
    return candidates;
  }
  return candidates.filter((candidate) => projectIdFilter.has(candidate.projectId));
}

/**
 * ハーネス KPI (docs/HARNESS-EVALUATION.md §4.4 / §5 P4)。
 *
 * 集計期間は統計タブの週数セレクタに合わせる: 開始は buildWeekStarts の先頭週の
 * 月曜 0 時 (ボードのタイムゾーン)、終了は now。reclaim 指標だけはサーバー起動から
 * の記録しか無いので、実効期間は max(期間開始, サーバー起動) になる — その旨を
 * reclaimSince で返す。
 */
export function getHarnessKpi(
  cache: BoardCache,
  now: Date,
  options?: GetHarnessKpiOptions,
): HarnessKpiStats {
  const weeks = Math.max(1, options?.weeks ?? DEFAULT_WEEKS);
  const timeZone = options?.timeZone ?? getBoardTimeZone();
  const weekStarts = buildWeekStarts(now, weeks, timeZone);
  const rangeStart = weekStarts[0] ?? now;
  const projectIdFilter =
    options?.projectIds !== undefined ? new Set(options.projectIds) : undefined;

  const kpi = computeHarnessKpi({
    tickets: collectTickets(cache, projectIdFilter),
    range: { start: rangeStart, end: now },
    ...(options?.reclaimRuns !== undefined
      ? { reclaimRuns: filterReclaimRuns(options.reclaimRuns, projectIdFilter) }
      : {}),
    ...(options?.leftoverCandidates !== undefined
      ? {
          leftoverCandidates: filterLeftoverCandidates(
            options.leftoverCandidates,
            projectIdFilter,
          ),
        }
      : {}),
  });

  return {
    kpi,
    reclaimSince: options?.reclaimSince ?? null,
    reclaimUnparsedRunCount: options?.reclaimUnparsedRunCount ?? 0,
    leftoverScanComplete: options?.leftoverScanComplete ?? true,
  };
}
