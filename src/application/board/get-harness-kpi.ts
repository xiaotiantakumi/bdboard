import { getBoardTimeZone } from '../../config/board-timezone.js';
import type { LeftoverCandidate } from '../../domain/git-worktree.js';
import {
  createHarnessKpiAccumulator,
  type HarnessKpi,
  type HarnessKpiAccumulator,
  type ReclaimRunRecord,
} from '../../domain/harness-kpi.js';
import type { BoardCache, CachedProject } from '../ports/board-cache.js';
import { createYieldGate, forEachChunked } from './aggregation-yield.js';
import { readProjectEntries } from './read-cached-projects.js';
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

async function collectProjectEntries(
  cache: BoardCache,
  projectIdFilter?: ReadonlySet<string>,
): Promise<readonly CachedProject[]> {
  // bdboard-4x55: getThroughputStats / getModelStats (bdboard-mkkx) と同じ理由で
  // listProjectsChunked() を優先し、無ければ (インメモリ fake 等) listProjects() に
  // 同じ結果でフォールバックする。
  const entries = await readProjectEntries(cache);
  return projectIdFilter === undefined
    ? entries
    : entries.filter((entry) => projectIdFilter.has(entry.project.id));
}

/**
 * 全プロジェクトのチケットを集計器へ流し込む (bdboard-kuui)。
 *
 * 以前は全チケットを 1 本の配列に積んで computeHarnessKpi (同期・4 回走査) に渡して
 * いたため、200,000 件 / 200 プロジェクトで最大イベントループ間隔が静かなマシン
 * (load 約 3) で 53〜93ms、負荷下 (load 約 10) で 190〜350ms (チケット記載は 281〜656ms)
 * にもなっていた。いまは集計器の add を 1 件ずつ呼び、forEachChunked でチャンク境界
 * ごとに制御を返す。gate はプロジェクトをまたいで共有するので、境界は通算件数で
 * 決まる (小さなプロジェクトが大量にあっても、プロジェクトごとにカウンタが
 * リセットされて yield し損ねることはない)。
 * 配列に積まないので、巨大プロジェクトでの RangeError (bdboard-6nq2) とも無縁。
 */
async function addTicketsChunked(
  accumulator: HarnessKpiAccumulator,
  entries: readonly CachedProject[],
): Promise<void> {
  const gate = createYieldGate();
  for (const entry of entries) {
    await forEachChunked(entry.tickets, (ticket) => accumulator.add(ticket), gate);
  }
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
export async function getHarnessKpi(
  cache: BoardCache,
  now: Date,
  options?: GetHarnessKpiOptions,
): Promise<HarnessKpiStats> {
  const weeks = Math.max(1, options?.weeks ?? DEFAULT_WEEKS);
  const timeZone = options?.timeZone ?? getBoardTimeZone();
  const weekStarts = buildWeekStarts(now, weeks, timeZone);
  const rangeStart = weekStarts[0] ?? now;
  const projectIdFilter =
    options?.projectIds !== undefined ? new Set(options.projectIds) : undefined;

  const accumulator = createHarnessKpiAccumulator({
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
  await addTicketsChunked(accumulator, await collectProjectEntries(cache, projectIdFilter));
  const kpi = accumulator.finish();

  return {
    kpi,
    reclaimSince: options?.reclaimSince ?? null,
    reclaimUnparsedRunCount: options?.reclaimUnparsedRunCount ?? 0,
    leftoverScanComplete: options?.leftoverScanComplete ?? true,
  };
}
