import type { ReclaimRunRecord } from '../../domain/harness-kpi.js';

/**
 * reclaim 発火のリングバッファ。**サーバー起動からの累積で、永続化しない**
 * (docs/HARNESS-EVALUATION.md §5 P4)。プロセスが落ちれば消えるので、UI 側は
 * `startedAt` を「この数字が何時以降のものか」の注記として必ず出す。
 */
export const DEFAULT_RECLAIM_HISTORY_LIMIT = 500;

export interface ReclaimHistory {
  /**
   * 1 実行分を積む。**何も回収しなかった実行は捨てる** — スケジューラは 5 分ごとに
   * 空振りするので、それを積むと数時間でバッファが空振りだけで埋まり、
   * 「発火回数」が「巡回回数」になってしまう。
   */
  record(run: ReclaimRunRecord): void;
  /** 古い順 */
  list(): readonly ReclaimRunRecord[];
  /** 記録を始めた時刻 (= サーバー起動時刻) */
  readonly startedAt: Date;
}

export interface CreateReclaimHistoryOptions {
  readonly maxEntries?: number;
  readonly startedAt?: Date;
}

function isFiring(run: ReclaimRunRecord): boolean {
  // count が読めなかった実行は「何かあったかもしれない」ので残す。
  return run.reclaimedCount === null || run.reclaimedCount > 0 || run.ticketIds.length > 0;
}

export function createReclaimHistory(
  options?: CreateReclaimHistoryOptions,
): ReclaimHistory {
  const maxEntries = Math.max(1, options?.maxEntries ?? DEFAULT_RECLAIM_HISTORY_LIMIT);
  const startedAt = options?.startedAt ?? new Date();
  const runs: ReclaimRunRecord[] = [];

  return {
    startedAt,

    record(run) {
      if (!isFiring(run)) {
        return;
      }
      runs.push(run);
      if (runs.length > maxEntries) {
        runs.splice(0, runs.length - maxEntries);
      }
    },

    list() {
      return [...runs];
    },
  };
}
