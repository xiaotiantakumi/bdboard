import type { HarnessWorktreeLag } from '../../domain/hygiene.js';
import type { InFlightWorktree } from '../../domain/in-flight-overlap.js';
import { runWithConcurrencyLimit } from '../concurrency.js';
import type { WorktreeScanner } from '../ports/worktree-scanner.js';
import { describeFetchFailures, type FetchFailure } from './fetch-failure-log.js';

/** scan-in-flight-overlaps と同じ 3。git を叩く回数の桁を揃える。 */
const WORKTREE_SCAN_CONCURRENCY = 3;

/** worktree 1 本あたりの締め切り。scan-in-flight-overlaps と同じ理由・同じ値。 */
const WORKTREE_DEADLINE_MS = 15_000;

export interface ScanHarnessWorktreeLagsOptions {
  readonly logWarn?: (message: string) => void;
  readonly worktreeDeadlineMs?: number;
  /**
   * 計測対象にする worktree。未指定なら全件。
   *
   * 呼び出し側の一覧は open / blocked の worktree も含むが、domain が採用するのは
   * in_progress だけ (checkStaleHarnessWorktree)。捨てるものに git を起こさないための
   * 絞り込みで、**判定そのものは domain 側が持つ** (ここを緩めても結果は変わらない)。
   */
  readonly shouldMeasure?: (worktree: InFlightWorktree) => boolean;
}

async function withDeadline<T>(
  work: Promise<T>,
  deadlineMs: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`timed out after ${deadlineMs}ms reading ${label}`));
        }, deadlineMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/**
 * 着手中 worktree のハーネスが既定ブランチから何コミット遅れているかを測る (bdboard-tdua)。
 *
 * scanner が `countHarnessCommitsBehindDefaultBranch` を持たない (既定ブランチの ref が無い
 * 環境・テストのスタブ) なら **空配列**を返す。読めなかった worktree はそのぶんだけ
 * 落として続ける — 1 本壊れているだけで盤面から警告が丸ごと消えるほうが困る。
 *
 * **「測れなかった」は「遅れていない」ではない。** 空配列も、失敗して落ちた worktree も、
 * 単にその worktree について何も言っていないという意味しか持たない。
 */
export async function scanHarnessWorktreeLags(
  worktrees: readonly InFlightWorktree[],
  scanner: WorktreeScanner,
  options?: ScanHarnessWorktreeLagsOptions,
): Promise<readonly HarnessWorktreeLag[]> {
  const countCommitsBehind = scanner.countHarnessCommitsBehindDefaultBranch?.bind(scanner);
  if (countCommitsBehind === undefined || worktrees.length === 0) {
    return [];
  }

  const shouldMeasure = options?.shouldMeasure;
  const targets =
    shouldMeasure === undefined ? worktrees : worktrees.filter((w) => shouldMeasure(w));
  if (targets.length === 0) {
    return [];
  }

  const lags: HarnessWorktreeLag[] = [];
  const failures: FetchFailure[] = [];
  const deadlineMs = options?.worktreeDeadlineMs ?? WORKTREE_DEADLINE_MS;

  await runWithConcurrencyLimit(targets, WORKTREE_SCAN_CONCURRENCY, async (worktree) => {
    try {
      const commitsBehind = await withDeadline(
        Promise.resolve(countCommitsBehind(worktree.worktreePath)),
        deadlineMs,
        worktree.worktreePath,
      );
      lags.push({
        projectId: worktree.projectId,
        ticketId: worktree.ticketId,
        worktreePath: worktree.worktreePath,
        commitsBehind,
      });
    } catch (error) {
      failures.push({ id: worktree.ticketId, error });
    }
  });

  if (failures.length > 0) {
    const logWarn = options?.logWarn ?? ((message: string) => console.warn(message));
    logWarn(
      '[hygiene] could not measure how far some in-flight worktrees lag behind the default ' +
        'branch; stale harness warnings for those tickets are missing from the panel. ' +
        describeFetchFailures(failures, targets.length),
    );
  }

  return lags;
}
