import {
  computeInFlightOverlaps,
  type InFlightFileEntry,
  type InFlightOverlap,
  type InFlightWorktree,
} from '../../domain/in-flight-overlap.js';
import { runWithConcurrencyLimit } from '../concurrency.js';
import type { WorktreeScanner } from '../ports/worktree-scanner.js';
import { describeFetchFailures, type FetchFailure } from './fetch-failure-log.js';

/**
 * worktree を同時に何本まで読むか。leftovers スキャン (PROJECT_SCAN_CONCURRENCY)
 * と同じ 3。1 本あたり git を最大 4 回叩くので、十数本の worktree があるマシンで
 * 無制限に並べると盤面更新のたびに git が数十本立ち上がる。
 */
const WORKTREE_SCAN_CONCURRENCY = 3;

export interface ScanInFlightOverlapsOptions {
  /** 取得失敗の警告ログ。未指定なら console.warn (scanGitLeftovers と同じ注入流儀)。 */
  readonly logWarn?: (message: string) => void;
}

/**
 * 着手中 worktree の変更ファイルを読み、同じファイルを触っているチケットのペアを返す。
 *
 * git が失敗した worktree は **そのチケットだけ落として続ける**。1 本の worktree が
 * 壊れている (rebase 途中、origin が無い、権限が無い) だけで盤面から警告が丸ごと
 * 消えるほうが困る。落としたぶんは呼び出し 1 回につき 1 行に畳んで警告する。
 */
export async function scanInFlightOverlaps(
  worktrees: readonly InFlightWorktree[],
  scanner: WorktreeScanner,
  options?: ScanInFlightOverlapsOptions,
): Promise<readonly InFlightOverlap[]> {
  if (worktrees.length === 0) {
    return [];
  }

  const entries: InFlightFileEntry[] = [];
  const failures: FetchFailure[] = [];

  await runWithConcurrencyLimit(worktrees, WORKTREE_SCAN_CONCURRENCY, async (worktree) => {
    try {
      const files = await scanner.listChangedFiles(worktree.worktreePath);
      entries.push({
        ticketId: worktree.ticketId,
        projectId: worktree.projectId,
        files,
      });
    } catch (error) {
      failures.push({ id: worktree.ticketId, error });
    }
  });

  if (failures.length > 0) {
    const logWarn = options?.logWarn ?? ((message: string) => console.warn(message));
    logWarn(
      '[hygiene] could not read changed files for some in-flight worktrees; ' +
        'file overlaps involving those tickets are missing from the panel. ' +
        describeFetchFailures(failures, worktrees.length),
    );
  }

  return computeInFlightOverlaps(entries);
}
