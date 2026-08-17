import path from 'node:path';
import { compareStrings } from '../../domain/compare.js';
import type { Project } from '../../domain/project.js';
import { stripTrailingSeparators } from '../../domain/scan-root-policy.js';
import type { CommandRunner } from '../ports/command-runner.js';
import type { FileSystemPort } from '../ports/file-system.js';
import type { ProjectDiscoveryConfig } from '../ports/project-discovery.js';

export interface DiscoverProjectsDeps {
  readonly fs: FileSystemPort;
  readonly commandRunner: CommandRunner;
  readonly config: ProjectDiscoveryConfig;
  /** 走査打ち切り等の警告ログ。未指定なら console.warn(reclaim-scheduler と同じ注入流儀)。 */
  readonly logWarn?: (message: string) => void;
}

/**
 * 既定スキャンルートはユーザーの Documents フォルダ(bdboard-3tw.102.1)なので、
 * `~/Documents/src/private_src/<group>/<project>` のような入れ子レイアウトに届く深さが要る。
 * 以前の既定ルートは `~/Documents/src/private_src` 固定で2階層深く、3で足りていた。
 */
export const DEFAULT_MAX_DEPTH = 5;

/**
 * 1 スキャンで訪問するディレクトリ数の既定上限(bdboard-bzd)。
 * scanRoots に巨大なツリー(誤設定・悪意の別なく)を指定されても、走査がここで
 * 打ち切られて部分結果を返す。上書きは ProjectDiscoveryConfig.maxDirectories
 * (env: BDBOARD_SCAN_DIR_LIMIT — infrastructure 層で解決)から。
 */
export const DEFAULT_SCAN_DIR_LIMIT = 50_000;

interface WalkBudget {
  readonly limit: number;
  visited: number;
  truncated: boolean;
}

export const SKIPPED_DIR_NAMES: readonly string[] = [
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  '.venv',
  'venv',
  '__pycache__',
  '.cache',
  'vendor',
  'Pods',
  '.claude',
];

export async function discoverProjects(deps: DiscoverProjectsDeps): Promise<readonly Project[]> {
  const { fs, commandRunner, config } = deps;
  const logWarn = deps.logWarn ?? ((message: string) => console.warn(message));
  const maxDepth = config.maxDepth ?? DEFAULT_MAX_DEPTH;
  const scanRoots = [...new Set(config.scanRoots)].sort(compareStrings);
  // PUT 経路では末尾セパレータを strip 済みだが、設定ファイルの手編集や旧設定の
  // '/path/' 形エントリは store をそのまま素通りしてくる。isExcluded は文字列比較なので
  // 消費時にも正規化し、prune/filter の不変条件を保存経路に依存させない(bdboard-4iw)。
  // scanRoots に同種の消費点検証が無いのは意図的な非対称: 手編集はローカル FS 権限が
  // 前提で、bzd の脅威モデル(トンネル書き込みだけで危険設定を注入できること)の外(N5)。
  const excludePaths = (config.excludePaths ?? []).map(stripTrailingSeparators);

  const candidates: string[] = [];
  const budget: WalkBudget = {
    // `?? DEFAULT` だけだと 0 指定が「即打ち切り」になるので正値のみ採用する(N12)。
    limit:
      config.maxDirectories !== undefined && config.maxDirectories > 0
        ? config.maxDirectories
        : DEFAULT_SCAN_DIR_LIMIT,
    visited: 0,
    truncated: false,
  };
  // 上限は全 scanRoots で共有され、ソート順に消費される。打ち切り発生以降の root は
  // 丸ごと(または途中から)走査されないため、どの root が不完全かを警告に含める(SF3)。
  const truncatedRoots: string[] = [];

  for (const scanRoot of scanRoots) {
    await collectCandidates(fs, scanRoot, 0, maxDepth, candidates, budget, excludePaths);
    if (budget.truncated) {
      truncatedRoots.push(scanRoot);
    }
  }

  if (budget.truncated) {
    logWarn(
      `[discovery] scan aborted after visiting ${budget.limit} directories ` +
        '(BDBOARD_SCAN_DIR_LIMIT); results are partial. ' +
        `Roots not fully scanned: ${truncatedRoots.join(', ')}. ` +
        'Narrow scanRoots or add excludePaths in the settings.',
    );
  }

  const normalizedPaths: string[] = [];
  const aliasPathsByRoot = new Map<string, Set<string>>();

  for (const candidate of candidates) {
    const adopted = await normalizeWorktreeRoot(fs, commandRunner, candidate);
    const resolved = await fs.realPath(adopted);
    normalizedPaths.push(resolved);

    if (adopted !== candidate) {
      const aliasResolved = await fs.realPath(candidate);
      if (aliasResolved !== resolved) {
        let aliases = aliasPathsByRoot.get(resolved);
        if (aliases === undefined) {
          aliases = new Set<string>();
          aliasPathsByRoot.set(resolved, aliases);
        }
        aliases.add(aliasResolved);
      }
    }
  }

  const uniquePaths = [...new Set(normalizedPaths)];
  const filtered = uniquePaths.filter((p) => !isExcluded(p, excludePaths));

  const projects: Project[] = filtered.map((rootPath) => {
    const aliasSet = aliasPathsByRoot.get(rootPath);
    const aliasPaths =
      aliasSet !== undefined ? [...aliasSet].sort(compareStrings) : [];

    return {
      id: rootPath,
      name: path.basename(rootPath),
      rootPath,
      // prefixes are populated from bd data in S3; always empty during discovery.
      prefixes: [],
      aliasPaths,
    };
  });

  projects.sort((a, b) => compareStrings(a.rootPath, b.rootPath));
  return projects;
}

async function collectCandidates(
  fs: FileSystemPort,
  dir: string,
  depth: number,
  maxDepth: number,
  candidates: string[],
  budget: WalkBudget,
  excludePaths: readonly string[],
): Promise<void> {
  if (depth > maxDepth) {
    return;
  }

  // excludePaths 配下は walk 自体を刈り込み、budget を消費させない(SF4)。
  // 「results are partial → 巨大サブツリーを除外する」というユーザーの自然な対処を
  // 実際に効かせるため。後段の結果フィルタ(isExcluded)も維持する(二重でも害なし)。
  if (isExcluded(dir, excludePaths)) {
    return;
  }

  if (budget.visited >= budget.limit) {
    budget.truncated = true;
    return;
  }
  budget.visited += 1;

  let entries;
  try {
    entries = await fs.readDir(dir);
  } catch {
    return;
  }

  if (await hasBeadsDirectory(fs, dir, entries)) {
    candidates.push(dir);
    return;
  }

  if (depth >= maxDepth) {
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory) {
      continue;
    }
    if (entry.isSymbolicLink) {
      continue;
    }
    if (entry.name.startsWith('.')) {
      continue;
    }
    if (SKIPPED_DIR_NAMES.includes(entry.name)) {
      continue;
    }

    await collectCandidates(
      fs,
      path.join(dir, entry.name),
      depth + 1,
      maxDepth,
      candidates,
      budget,
      excludePaths,
    );
  }
}

async function hasBeadsDirectory(
  fs: FileSystemPort,
  dir: string,
  entries?: Awaited<ReturnType<FileSystemPort['readDir']>>,
): Promise<boolean> {
  try {
    const dirEntries = entries ?? (await fs.readDir(dir));
    return dirEntries.some((entry) => entry.name === '.beads' && entry.isDirectory);
  } catch {
    return false;
  }
}

async function normalizeWorktreeRoot(
  fs: FileSystemPort,
  commandRunner: CommandRunner,
  candidate: string,
): Promise<string> {
  const result = await commandRunner.run(
    'git',
    ['rev-parse', '--path-format=absolute', '--git-common-dir'],
    { cwd: candidate },
  );

  if (result.exitCode !== 0 || result.stdout.trim() === '') {
    return candidate;
  }

  const gitCommonDir = result.stdout.trim();
  const canonical = path.dirname(gitCommonDir);

  if (await hasBeadsDirectory(fs, canonical)) {
    return canonical;
  }

  return candidate;
}

// 比較前に両辺を '/' 区切りへ正準化する(bdboard-4iw RS1 = bdboard-h7f)。UI ヒントが
// 'C:/Users/you/projects' 形を案内する以上、「exclude がスラッシュ形 × 実パスが
// バックスラッシュ形」の全組み合わせで境界判定が効く必要がある。POSIX で '\' を含む
// ディレクトリ名が over-exclude になる副作用は、安全側方向かつ発生確率極小として許容
// (裁定済み — プラットフォーム分岐は入れない)。
// なお excluded に '/' や 'C:\' (ルートそのもの)を指定しても、`${excluded}/` が '//' 等の
// 実在しない prefix になるためこの意味論では実質 no-op — scanRoot 側と違い実害がないので
// 意図的にエラーにはしない(N4)。
function isExcluded(projectPath: string, excludePaths: readonly string[]): boolean {
  const canonicalPath = projectPath.replaceAll('\\', '/');
  return excludePaths.some((excluded) => {
    const canonicalExcluded = excluded.replaceAll('\\', '/');
    return (
      canonicalPath === canonicalExcluded ||
      canonicalPath.startsWith(`${canonicalExcluded}/`)
    );
  });
}
