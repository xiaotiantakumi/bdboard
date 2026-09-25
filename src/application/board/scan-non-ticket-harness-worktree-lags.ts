import type { NonTicketWorktree } from '../../domain/git-worktree.js';
import type { NonTicketHarnessWorktreeLag } from '../../domain/non-ticket-harness-worktree.js';
import { runWithConcurrencyLimit } from '../concurrency.js';
import type { WorktreeScanner } from '../ports/worktree-scanner.js';
import { describeFetchFailures, type FetchFailure } from './fetch-failure-log.js';
import { withDeadline } from './with-deadline.js';

/** scan-harness-worktree-lags と同じ 3。git を叩く回数の桁を揃える。 */
const WORKTREE_SCAN_CONCURRENCY = 3;

/** worktree 1 本あたりの締め切り。scan-harness-worktree-lags と同じ理由・同じ値。 */
const WORKTREE_DEADLINE_MS = 15_000;

export interface ScanNonTicketHarnessWorktreeLagsOptions {
  readonly logWarn?: (message: string) => void;
  readonly worktreeDeadlineMs?: number;
  /** プロジェクトの検証コントラクトが宣言する既定ブランチ。読めなければ undefined。 */
  readonly resolveMainBranch?: (projectId: string) => string | undefined;
}

/**
 * `bd/<id>` に紐づかない worktree (feature/* 等) のハーネスが既定ブランチから何コミット
 * 遅れているかを測る (bdboard-wadg。ticket 版は scanHarnessWorktreeLags / bdboard-tdua)。
 *
 * scanner が `countHarnessCommitsBehindDefaultBranch` を持たない (既定ブランチの ref が無い
 * 環境・テストのスタブ) なら **空配列**を返す。読めなかった worktree はそのぶんだけ
 * 落として続ける — 1 本壊れているだけで盤面から警告が丸ごと消えるほうが困る。
 *
 * **「測れなかった」は「遅れていない」ではない。** 空配列も、失敗して落ちた worktree も、
 * 単にその worktree について何も言っていないという意味しか持たない。
 */
export async function scanNonTicketHarnessWorktreeLags(
  worktrees: readonly NonTicketWorktree[],
  scanner: WorktreeScanner,
  options?: ScanNonTicketHarnessWorktreeLagsOptions,
): Promise<readonly NonTicketHarnessWorktreeLag[]> {
  const countCommitsBehind = scanner.countHarnessCommitsBehindDefaultBranch?.bind(scanner);
  if (countCommitsBehind === undefined || worktrees.length === 0) {
    return [];
  }

  const lags: NonTicketHarnessWorktreeLag[] = [];
  const failures: FetchFailure[] = [];
  const deadlineMs = options?.worktreeDeadlineMs ?? WORKTREE_DEADLINE_MS;

  await runWithConcurrencyLimit(worktrees, WORKTREE_SCAN_CONCURRENCY, async (worktree) => {
    try {
      const measurement = await withDeadline(
        Promise.resolve(
          countCommitsBehind(worktree.worktreePath, {
            mainBranch: options?.resolveMainBranch?.(worktree.projectId),
          }),
        ),
        deadlineMs,
        worktree.worktreePath,
      );
      lags.push({
        projectId: worktree.projectId,
        worktreePath: worktree.worktreePath,
        branchName: worktree.branchName,
        commitsBehind: measurement.commitsBehind,
        baseRef: measurement.baseRef,
        hasCommonAncestor: measurement.hasCommonAncestor,
      });
    } catch (error) {
      failures.push({ id: worktree.worktreePath, error });
    }
  });

  if (failures.length > 0) {
    const logWarn = options?.logWarn ?? ((message: string) => console.warn(message));
    logWarn(
      '[hygiene] could not measure how far some non-ticket worktrees lag behind the default ' +
        'branch; stale harness warnings for those worktrees are missing from the panel. ' +
        describeFetchFailures(failures, worktrees.length),
    );
  }

  return lags;
}
