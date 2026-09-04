import type { ReclaimRunRecord } from '../../domain/harness-kpi.js';

/**
 * reclaim 発火のリングバッファ。**サーバー起動からの累積で、永続化しない**
 * (docs/HARNESS-EVALUATION.md §5 P4)。プロセスが落ちれば消えるので、UI 側は
 * `since()` を「この数字が何時以降のものか」の注記として必ず出す。
 */
export const DEFAULT_RECLAIM_HISTORY_LIMIT = 500;

export interface ReclaimHistory {
  /**
   * 1 実行分を積む。**何も回収しなかった実行は捨てる** — スケジューラは 5 分ごとに
   * 空振りするので (1 プロジェクトあたり 1 日 288 回)、それを積むとバッファが空振り
   * だけで埋まり、(a)「発火回数」が「巡回回数」に化け、(b) 本物の reclaim が押し
   * 出されて消える。
   *
   * 件数が読めなかった実行 (count=null) も積まない。bd の空振り出力
   * `✓ No stale leases to reclaim` は parse 側で 0 件として読めるので、ここに
   * 落ちてくる null は「出力形式が変わった」ケースであり、量としては空振りと同じ
   * ペースで来うる。捨てたことが見えなくならないよう `unparsedRunCount()` で数える。
   */
  record(run: ReclaimRunRecord): void;
  /** 古い順 */
  list(): readonly ReclaimRunRecord[];
  /**
   * この統計が「いつ以降」のものか。通常は記録開始時刻 (= サーバー起動時刻) だが、
   * バッファが上限に達して古い記録を捨てた後は**バッファ先頭の実行時刻**を返す。
   * 起動時刻のまま出すと、捨てた区間まで網羅しているように見えてしまう。
   */
  since(): Date;
  /** count を読めず捨てた実行の累積回数 (バッファには入らない) */
  unparsedRunCount(): number;
}

export interface CreateReclaimHistoryOptions {
  readonly maxEntries?: number;
  readonly startedAt?: Date;
}

function isFiring(run: ReclaimRunRecord): boolean {
  return (run.reclaimedCount !== null && run.reclaimedCount > 0) || run.ticketIds.length > 0;
}

export function createReclaimHistory(
  options?: CreateReclaimHistoryOptions,
): ReclaimHistory {
  const maxEntries = Math.max(1, options?.maxEntries ?? DEFAULT_RECLAIM_HISTORY_LIMIT);
  const startedAt = options?.startedAt ?? new Date();
  const runs: ReclaimRunRecord[] = [];
  let unparsedRuns = 0;
  let evicted = false;

  return {
    record(run) {
      if (run.reclaimedCount === null && run.ticketIds.length === 0) {
        unparsedRuns += 1;
        return;
      }
      if (!isFiring(run)) {
        return;
      }
      runs.push(run);
      if (runs.length > maxEntries) {
        runs.splice(0, runs.length - maxEntries);
        evicted = true;
      }
    },

    list() {
      return [...runs];
    },

    since() {
      if (!evicted) {
        return startedAt;
      }
      return runs[0]?.at ?? startedAt;
    },

    unparsedRunCount() {
      return unparsedRuns;
    },
  };
}
