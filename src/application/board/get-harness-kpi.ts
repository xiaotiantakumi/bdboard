import { getBoardTimeZone } from '../../config/board-timezone.js';
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
}

export interface HarnessKpiStats {
  readonly kpi: HarnessKpi;
  readonly reclaimSince: Date | null;
}

const DEFAULT_WEEKS = 8;

function collectTickets(
  cache: BoardCache,
  projectIdFilter?: readonly string[],
): readonly Ticket[] {
  let entries = cache.listProjects();
  if (projectIdFilter !== undefined) {
    const filterSet = new Set(projectIdFilter);
    entries = entries.filter((entry) => filterSet.has(entry.project.id));
  }

  const tickets: Ticket[] = [];
  for (const entry of entries) {
    tickets.push(...entry.tickets);
  }
  return tickets;
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

  const kpi = computeHarnessKpi({
    tickets: collectTickets(cache, options?.projectIds),
    range: { start: rangeStart, end: now },
    ...(options?.reclaimRuns !== undefined ? { reclaimRuns: options.reclaimRuns } : {}),
  });

  return {
    kpi,
    reclaimSince: options?.reclaimSince ?? null,
  };
}
