import type { ScannerDeps } from './deps.js';
import { runGitReadOnly } from './git-command.js';
import { readHeadSha, resolveMergeBase } from './merge-base.js';
import { splitNulRecords } from './nul-records.js';
import { normalizeFiles, parseStatusPorcelainZ } from './status-parsing.js';

/**
 * キャッシュを丸ごと捨てる上限。worktree は作られては消えるので、消えたぶんの
 * エントリが永遠に残らないようにする。常時稼働サーバーの寿命が長いことへの保険で、
 * 実際の同時 worktree 数 (十数本) からは遠い。
 */
const CHANGED_FILES_CACHE_MAX = 200;

/**
 * キャッシュするのは **コミット済み差分 (`mergeBase...HEAD`) だけ**。
 *
 * 作業ツリー側 (`git status`) は毎回読み直す。当初は「HEAD の SHA + index の mtime」を
 * キーに全体をキャッシュしていたが、`--no-optional-locks` を付けた結果 git が index を
 * 書き戻さなくなり、**ファイルを編集しても未追跡ファイルを足しても index の mtime が
 * 動かない** (`git add` するまで動かない) ため、作業ツリーの変更が盤面に出なくなって
 * いた (実測で再現)。コミット済み差分のほうは HEAD と merge-base が動かない限り
 * 変わらないので、この 2 つをキーにするのは安全。
 *
 * merge-base をキーに含めるのは、他セッションの `git fetch` で origin/main が進むと
 * HEAD が同じままでも差分が変わるため。
 */
interface CommittedFilesCacheEntry {
  readonly headSha: string;
  readonly mergeBase: string;
  readonly files: readonly string[];
}

export function createChangedFilesReader(
  deps: ScannerDeps,
): (worktreePath: string) => Promise<readonly string[]> {
  const { commandRunner, gitPath, timeoutMs } = deps;
  const committedFilesCache = new Map<string, CommittedFilesCacheEntry>();

  return async function listChangedFiles(worktreePath: string): Promise<readonly string[]> {
    const [headSha, mergeBase] = await Promise.all([
      readHeadSha(deps, worktreePath),
      resolveMergeBase(deps, worktreePath),
    ]);

    // 作業ツリー側は毎回読む。キャッシュできるのはコミット済み差分だけ
    // (CommittedFilesCacheEntry のコメント参照)。
    const statusPromise = runGitReadOnly(
      commandRunner,
      gitPath,
      worktreePath,
      ['status', '--porcelain', '-z', '--untracked-files=all'],
      timeoutMs,
    );
    // この後の diff が throw すると status の Promise を誰も待たないまま関数を抜け、
    // Node の unhandled rejection になる (v15 以降は既定でプロセスが落ちる)。
    // ここでハンドラを 1 つ足しておく。下の `await statusPromise` は影響を受けない
    // ので、status 自身の失敗はこれまでどおり throw する。
    statusPromise.catch(() => {});

    const cached = committedFilesCache.get(worktreePath);
    let committedFiles: readonly string[];
    if (cached !== undefined && cached.headSha === headSha && cached.mergeBase === mergeBase) {
      committedFiles = cached.files;
    } else {
      const diffResult = await runGitReadOnly(
        commandRunner,
        gitPath,
        worktreePath,
        ['diff', '--name-only', '--no-renames', '-z', `${mergeBase}...HEAD`],
        timeoutMs,
      );
      if (diffResult.exitCode !== 0) {
        throw new Error(
          `git diff failed in ${worktreePath} (exit ${diffResult.exitCode}): ${diffResult.stderr.trim()}`,
        );
      }
      committedFiles = splitNulRecords(diffResult.stdout);
      if (committedFilesCache.size >= CHANGED_FILES_CACHE_MAX) {
        committedFilesCache.clear();
      }
      committedFilesCache.set(worktreePath, { headSha, mergeBase, files: committedFiles });
    }

    const statusResult = await statusPromise;
    if (statusResult.exitCode !== 0) {
      throw new Error(
        `git status failed in ${worktreePath} (exit ${statusResult.exitCode}): ${statusResult.stderr.trim()}`,
      );
    }

    return normalizeFiles([
      ...committedFiles,
      ...parseStatusPorcelainZ(statusResult.stdout),
    ]);
  };
}
