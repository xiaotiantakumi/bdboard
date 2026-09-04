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

/**
 * worktree 1 本あたりの締め切り。
 *
 * scanner 側の timeout は **git の 1 プロセスごと** (既定 10 秒) にしか効かないので、
 * 1 本の worktree が rev-parse / merge-base / diff / status と数珠つなぎに詰まると
 * 盤面全体がその合計ぶん待たされる。ここで頭を押さえて、遅い 1 本は「失敗」として
 * 落とす (落としたぶんは 1 行に畳んで警告する)。
 */
const WORKTREE_DEADLINE_MS = 15_000;

export interface ScanInFlightOverlapsOptions {
  /** 取得失敗の警告ログ。未指定なら console.warn (scanGitLeftovers と同じ注入流儀)。 */
  readonly logWarn?: (message: string) => void;
  /** worktree 1 本あたりの締め切り (ms)。テスト用。既定 WORKTREE_DEADLINE_MS */
  readonly worktreeDeadlineMs?: number;
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
  const deadlineMs = options?.worktreeDeadlineMs ?? WORKTREE_DEADLINE_MS;

  await runWithConcurrencyLimit(worktrees, WORKTREE_SCAN_CONCURRENCY, async (worktree) => {
    try {
      const files = await withDeadline(
        Promise.resolve(scanner.listChangedFiles(worktree.worktreePath)),
        deadlineMs,
        worktree.worktreePath,
      );
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
