import { isAbsolute, join } from 'node:path';
import type { CommandResult, CommandRunner } from '../../application/ports/command-runner.js';
import type { FileSystemPort } from '../../application/ports/file-system.js';
import type { WorktreeScanner } from '../../application/ports/worktree-scanner.js';
import { compareStrings } from '../../domain/compare.js';
import {
  BD_BRANCH_PREFIX,
  type GitWorktreeEntry,
  type GitWorktreeSnapshot,
} from '../../domain/git-worktree.js';

const DEFAULT_GIT_PATH = 'git';
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * merge-base の相手にする ref の候補。先に成功したものを使う。
 *
 * `npm run drift` (scripts/check-drift.mjs) は origin/main 決め打ちだが、こちらは
 * 注入先プロジェクトの worktree も見るので master / origin 無しにも耐えさせる。
 * ここでは **fetch しない**: 他セッションの worktree に対してネットワーク操作を
 * 走らせるのは読み取り専用の約束から外れるうえ、盤面の更新周期で毎回叩くには重い。
 * 手元の origin/main が数時間古いぶんの取りこぼしは許容する (着手中同士の重複は
 * どのみち merge-base より後ろのコミットで起きる)。
 */
const MERGE_BASE_CANDIDATE_REFS: readonly string[] = [
  'origin/main',
  'origin/master',
  'main',
  'master',
];

export interface GitWorktreeScannerOptions {
  readonly gitPath?: string;
  readonly timeoutMs?: number;
  /**
   * 変更ファイルのキャッシュ無効化に使う index の mtime を読む用。省略すると
   * キャッシュが効かなくなるだけで、結果は変わらない。
   */
  readonly fs?: FileSystemPort;
}

/**
 * キャッシュを丸ごと捨てる上限。worktree は作られては消えるので、消えたぶんの
 * エントリが永遠に残らないようにする。常時稼働サーバーの寿命が長いことへの保険で、
 * 実際の同時 worktree 数 (十数本) からは遠い。
 */
const CHANGED_FILES_CACHE_MAX = 200;

/** キャッシュのキー: HEAD の SHA と index の mtime。どちらも変わらなければ再利用する */
interface ChangedFilesCacheEntry {
  readonly headSha: string;
  readonly indexMtimeMs: number;
  readonly files: readonly string[];
}

async function runGit(
  commandRunner: CommandRunner,
  gitPath: string,
  rootPath: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<CommandResult> {
  return commandRunner.run(gitPath, ['-C', rootPath, ...args], { timeoutMs });
}

/**
 * `--no-optional-locks` 付きで git を読む。listChangedFiles 専用。
 *
 * 理由が 2 つある。
 *
 * 1. **他セッションの worktree に index.lock を取らない。** 通常の `git status` /
 *    `git diff` は stat キャッシュを更新して index を書き戻すため、盤面を開くたびに
 *    「別のエージェントが作業中の worktree」でロックを取りに行くことになる。読むだけの
 *    約束を、実装レベルでも守る。
 * 2. **キャッシュが実際に効く。** index を書き戻されると mtime が毎回変わり、
 *    HEAD SHA + index mtime のキャッシュが常に外れる (実測: warm でも毎回フル
 *    スキャンになり /api/hygiene が +2.5 秒)。
 */
async function runGitReadOnly(
  commandRunner: CommandRunner,
  gitPath: string,
  rootPath: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<CommandResult> {
  return commandRunner.run(gitPath, ['--no-optional-locks', '-C', rootPath, ...args], {
    timeoutMs,
  });
}

function parseWorktreePorcelain(output: string): GitWorktreeEntry[] {
  const entries: GitWorktreeEntry[] = [];
  const blocks = output.split('\n\n');
  let isFirst = true;

  for (const block of blocks) {
    const lines = block.split('\n').filter((line) => line.length > 0);
    if (lines.length === 0) {
      continue;
    }

    let worktreePath: string | null = null;
    let branch: string | null = null;
    let isBare = false;

    for (const line of lines) {
      if (line.startsWith('worktree ')) {
        worktreePath = line.slice('worktree '.length);
      } else if (line.startsWith('branch refs/heads/')) {
        branch = line.slice('branch refs/heads/'.length);
      } else if (line === 'bare') {
        isBare = true;
      }
    }

    // bare リポジトリのブロックも「先頭 = メイン」の枠を消費する。ここで isFirst を
    // 落とさずに continue すると、bare クローン + linked worktree 構成のときに最初の
    // linked worktree が isMain 扱いになり、本物の残骸を取りこぼす。
    const isMain = isFirst;
    isFirst = false;

    if (isBare || worktreePath === null) {
      continue;
    }

    entries.push({
      path: worktreePath,
      branch,
      isMain,
    });
  }

  return entries;
}

function parseBdBranches(output: string): string[] {
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && line.startsWith(BD_BRANCH_PREFIX))
    .sort(compareStrings);
}

/** NUL 区切り出力を分解する。末尾の空要素だけ落とす (途中の空要素は位置がずれるので残す) */
function splitNulRecords(output: string): string[] {
  const records = output.split('\0');
  while (records.length > 0 && records[records.length - 1] === '') {
    records.pop();
  }
  return records;
}

/**
 * `git status --porcelain -z` を分解する。
 *
 * `-z` を使うのは引用符処理を避けるため。`-z` 無しの porcelain は非 ASCII や空白を
 * 含むパスを `"..."` でエスケープして返すので、日本語ファイル名やスペース入りの
 * パスを素朴に slice すると壊れる。rename / copy のときは次のレコードが元パスに
 * なるので、両方を「触ったファイル」として拾う。
 */
function parseStatusPorcelainZ(output: string): string[] {
  const records = splitNulRecords(output);
  const files: string[] = [];

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    // 最短でも "XY p" の 4 文字。ここに満たないものは status 行ではない
    if (record.length < 4) {
      continue;
    }

    const x = record[0]!;
    const y = record[1]!;
    files.push(record.slice(3));

    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') {
      const source = records[index + 1];
      if (source !== undefined) {
        files.push(source);
        index += 1;
      }
    }
  }

  return files;
}

function normalizeFiles(files: readonly string[]): readonly string[] {
  const unique = new Set<string>();
  for (const file of files) {
    if (file.length > 0) {
      unique.add(file);
    }
  }
  return [...unique].sort(compareStrings);
}

export function createGitWorktreeScanner(
  commandRunner: CommandRunner,
  options?: GitWorktreeScannerOptions,
): WorktreeScanner {
  const gitPath = options?.gitPath ?? DEFAULT_GIT_PATH;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fs = options?.fs;
  const changedFilesCache = new Map<string, ChangedFilesCacheEntry>();

  /** HEAD の SHA と index の mtime。index が読めなければ mtime は null (= キャッシュしない) */
  async function readCacheKey(
    worktreePath: string,
  ): Promise<{ headSha: string; indexMtimeMs: number | null }> {
    // rev-parse は 1 回で 2 行返せる。probe のために git を 2 回叩かない
    const result = await runGitReadOnly(
      commandRunner,
      gitPath,
      worktreePath,
      ['rev-parse', 'HEAD', '--git-path', 'index'],
      timeoutMs,
    );
    if (result.exitCode !== 0) {
      throw new Error(
        `git rev-parse failed in ${worktreePath} (exit ${result.exitCode}): ${result.stderr.trim()}`,
      );
    }

    const lines = result.stdout.split('\n').map((line) => line.trim());
    const headSha = lines[0] ?? '';
    const rawIndexPath = lines[1] ?? '';
    if (headSha.length === 0) {
      throw new Error(`git rev-parse returned no HEAD for ${worktreePath}`);
    }

    if (fs === undefined || rawIndexPath.length === 0) {
      return { headSha, indexMtimeMs: null };
    }

    // `--git-path` は cwd 相対で返ることがある (メインチェックアウトでは '.git/index')。
    const indexPath = isAbsolute(rawIndexPath)
      ? rawIndexPath
      : join(worktreePath, rawIndexPath);
    const stat = await fs.stat(indexPath);
    return { headSha, indexMtimeMs: stat?.mtimeMs ?? null };
  }

  async function resolveMergeBase(worktreePath: string): Promise<string> {
    for (const ref of MERGE_BASE_CANDIDATE_REFS) {
      const result = await runGitReadOnly(
        commandRunner,
        gitPath,
        worktreePath,
        ['merge-base', ref, 'HEAD'],
        timeoutMs,
      );
      const base = result.stdout.trim();
      if (result.exitCode === 0 && base.length > 0) {
        return base;
      }
    }

    throw new Error(
      `no merge-base against ${MERGE_BASE_CANDIDATE_REFS.join(' / ')} in ${worktreePath}`,
    );
  }

  return {
    async scan(rootPath: string): Promise<GitWorktreeSnapshot> {
      const [worktreeResult, branchResult] = await Promise.all([
        runGit(commandRunner, gitPath, rootPath, ['worktree', 'list', '--porcelain'], timeoutMs),
        runGit(
          commandRunner,
          gitPath,
          rootPath,
          ['branch', '--list', 'bd/*', '--format=%(refname:short)'],
          timeoutMs,
        ),
      ]);

      const worktrees =
        worktreeResult.exitCode === 0 ? parseWorktreePorcelain(worktreeResult.stdout) : [];
      const bdBranches =
        branchResult.exitCode === 0 ? parseBdBranches(branchResult.stdout) : [];

      return { worktrees, bdBranches };
    },

    async listChangedFiles(worktreePath: string): Promise<readonly string[]> {
      const { headSha, indexMtimeMs } = await readCacheKey(worktreePath);

      const cached = changedFilesCache.get(worktreePath);
      if (
        cached !== undefined &&
        indexMtimeMs !== null &&
        cached.headSha === headSha &&
        cached.indexMtimeMs === indexMtimeMs
      ) {
        return cached.files;
      }

      const mergeBase = await resolveMergeBase(worktreePath);

      const [diffResult, statusResult] = await Promise.all([
        runGitReadOnly(
          commandRunner,
          gitPath,
          worktreePath,
          ['diff', '--name-only', '--no-renames', '-z', `${mergeBase}...HEAD`],
          timeoutMs,
        ),
        runGitReadOnly(
          commandRunner,
          gitPath,
          worktreePath,
          ['status', '--porcelain', '-z'],
          timeoutMs,
        ),
      ]);

      if (diffResult.exitCode !== 0) {
        throw new Error(
          `git diff failed in ${worktreePath} (exit ${diffResult.exitCode}): ${diffResult.stderr.trim()}`,
        );
      }
      if (statusResult.exitCode !== 0) {
        throw new Error(
          `git status failed in ${worktreePath} (exit ${statusResult.exitCode}): ${statusResult.stderr.trim()}`,
        );
      }

      const files = normalizeFiles([
        ...splitNulRecords(diffResult.stdout),
        ...parseStatusPorcelainZ(statusResult.stdout),
      ]);

      if (indexMtimeMs !== null) {
        if (changedFilesCache.size >= CHANGED_FILES_CACHE_MAX) {
          changedFilesCache.clear();
        }
        changedFilesCache.set(worktreePath, { headSha, indexMtimeMs, files });
      } else {
        // mtime が読めない間はキャッシュを持たない。古い結果を返し続けるより
        // 毎回 git を叩くほうがまし (worktree は同時に十数本しかない)。
        changedFilesCache.delete(worktreePath);
      }

      return files;
    },
  };
}
