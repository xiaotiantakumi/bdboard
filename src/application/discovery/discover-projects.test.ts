import { describe, expect, it, vi } from 'vitest';
import type { CommandResult, CommandRunner } from '../ports/command-runner.js';
import type { DirEntry, FileStat, FileSystemPort } from '../ports/file-system.js';
import { DEFAULT_MAX_DEPTH, discoverProjects } from './discover-projects.js';

interface FakeFsOptions {
  readonly dirs: Readonly<Record<string, readonly DirEntry[]>>;
  readonly realPaths?: Readonly<Record<string, string>>;
  readonly throwOnRead?: readonly string[];
  readonly stats?: Readonly<Record<string, FileStat>>;
  readonly files?: Readonly<Record<string, string>>;
}

/** 実装が path.join でネイティブ区切りを作るのは正しい。fake は POSIX キーの仮想ボリュームなので境界で吸収する (bdboard-9dm)。 */
function normalizeFakePath(pathValue: string): string {
  return pathValue.replaceAll('\\', '/');
}

function normalizeRecordKeys<T>(record: Readonly<Record<string, T>>): Readonly<Record<string, T>> {
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [normalizeFakePath(key), value]),
  );
}

function createFakeFs(options: FakeFsOptions): FileSystemPort {
  const dirs = normalizeRecordKeys(options.dirs);
  const realPaths = normalizeRecordKeys(options.realPaths ?? {});
  const { throwOnRead = [], stats: rawStats = {}, files: rawFiles = {} } = options;
  const stats = normalizeRecordKeys(rawStats);
  const files = normalizeRecordKeys(rawFiles);
  const throwSet = new Set(throwOnRead.map(normalizeFakePath));

  return {
    async readDir(dirPath: string): Promise<readonly DirEntry[]> {
      const key = normalizeFakePath(dirPath);
      if (throwSet.has(key)) {
        throw new Error(`EACCES: permission denied: ${dirPath}`);
      }
      const entries = dirs[key];
      if (entries === undefined) {
        throw new Error(`ENOENT: no such directory: ${dirPath}`);
      }
      return entries;
    },

    async isDirectory(dirPath: string): Promise<boolean> {
      return Object.prototype.hasOwnProperty.call(dirs, normalizeFakePath(dirPath));
    },

    async realPath(dirPath: string): Promise<string> {
      const key = normalizeFakePath(dirPath);
      return realPaths[key] ?? key;
    },

    async stat(filePath: string): Promise<FileStat | undefined> {
      return stats[normalizeFakePath(filePath)];
    },

    async readFile(filePath: string): Promise<string | undefined> {
      return files[normalizeFakePath(filePath)];
    },

    async readRange(filePath: string, start: number, length: number): Promise<string | undefined> {
      const content = files[normalizeFakePath(filePath)];
      if (content === undefined) {
        return undefined;
      }
      if (length <= 0) {
        return '';
      }
      const readStart = start < 0 ? 0 : start;
      return Buffer.from(content, 'utf8')
        .subarray(readStart, readStart + length)
        .toString('utf8');
    },

    async readRangeBytes(
      filePath: string,
      start: number,
      length: number,
    ): Promise<Buffer | undefined> {
      const content = files[normalizeFakePath(filePath)];
      if (content === undefined) {
        return undefined;
      }
      if (length <= 0) {
        return Buffer.alloc(0);
      }
      const readStart = start < 0 ? 0 : start;
      return Buffer.from(content, 'utf8').subarray(readStart, readStart + length);
    },
  };
}

interface FakeGitOptions {
  readonly responses: Readonly<Record<string, CommandResult>>;
}

function createFakeCommandRunner(options: FakeGitOptions): CommandRunner {
  const responses = normalizeRecordKeys(options.responses);

  return {
    async run(
      command: string,
      args: readonly string[],
      runOptions?: { cwd?: string },
    ): Promise<CommandResult> {
      if (command !== 'git' || args.join(' ') !== 'rev-parse --path-format=absolute --git-common-dir') {
        return { stdout: '', stderr: 'unexpected command', exitCode: 1 };
      }
      const cwd = normalizeFakePath(runOptions?.cwd ?? '');
      return responses[cwd] ?? { stdout: '', stderr: 'not a git repository', exitCode: 128 };
    },
  };
}

function dir(...names: string[]): DirEntry[] {
  return names.map((name) => ({
    name,
    isDirectory: true,
    isSymbolicLink: false,
  }));
}

function symlink(name: string): DirEntry {
  return { name, isDirectory: true, isSymbolicLink: true };
}

describe('discoverProjects', () => {
  const scanRoot = '/scan';

  it('finds .beads in a nested directory', async () => {
    const fs = createFakeFs({
      dirs: {
        [scanRoot]: dir('alpha'),
        [`${scanRoot}/alpha`]: dir('.beads'),
        [`${scanRoot}/alpha/.beads`]: [],
      },
    });

    const projects = await discoverProjects({
      fs,
      commandRunner: createFakeCommandRunner({ responses: {} }),
      config: { scanRoots: [scanRoot] },
    });

    expect(projects).toHaveLength(1);
    expect(projects[0]?.rootPath).toBe(`${scanRoot}/alpha`);
    expect(projects[0]?.name).toBe('alpha');
    expect(projects[0]?.id).toBe(`${scanRoot}/alpha`);
  });

  it('does NOT find .beads deeper than maxDepth', async () => {
    const fs = createFakeFs({
      dirs: {
        [scanRoot]: dir('a'),
        [`${scanRoot}/a`]: dir('b'),
        [`${scanRoot}/a/b`]: dir('c'),
        [`${scanRoot}/a/b/c`]: dir('d'),
        [`${scanRoot}/a/b/c/d`]: dir('.beads'),
        [`${scanRoot}/a/b/c/d/.beads`]: [],
      },
    });

    const projects = await discoverProjects({
      fs,
      commandRunner: createFakeCommandRunner({ responses: {} }),
      config: { scanRoots: [scanRoot], maxDepth: 3 },
    });

    expect(projects).toHaveLength(0);
  });

  it('finds a project nested 5 levels below the scan root with DEFAULT_MAX_DEPTH', async () => {
    // 既定スキャンルートが ~/Documents になった(bdboard-3tw.102.1)ことで、
    // ~/Documents/src/private_src/<group>/<project> は深さ5になる。
    // DEFAULT_MAX_DEPTH が足りないとこの形のプロジェクトが無言で消える。
    const fs = createFakeFs({
      dirs: {
        [scanRoot]: dir('src'),
        [`${scanRoot}/src`]: dir('private_src'),
        [`${scanRoot}/src/private_src`]: dir('webpages'),
        [`${scanRoot}/src/private_src/webpages`]: dir('mogu_pages'),
        [`${scanRoot}/src/private_src/webpages/mogu_pages`]: dir('nested-project'),
        [`${scanRoot}/src/private_src/webpages/mogu_pages/nested-project`]: dir('.beads'),
        [`${scanRoot}/src/private_src/webpages/mogu_pages/nested-project/.beads`]: [],
      },
    });

    const projects = await discoverProjects({
      fs,
      commandRunner: createFakeCommandRunner({ responses: {} }),
      config: { scanRoots: [scanRoot], maxDepth: DEFAULT_MAX_DEPTH },
    });

    expect(projects.map((p) => p.rootPath)).toEqual([
      `${scanRoot}/src/private_src/webpages/mogu_pages/nested-project`,
    ]);
  });

  it('does not traverse under node_modules / .git / .claude', async () => {
    const fs = createFakeFs({
      dirs: {
        [scanRoot]: dir('node_modules', '.git', '.claude', 'ok'),
        [`${scanRoot}/node_modules`]: dir('hidden-project'),
        [`${scanRoot}/node_modules/hidden-project`]: dir('.beads'),
        [`${scanRoot}/node_modules/hidden-project/.beads`]: [],
        [`${scanRoot}/.git`]: dir('hidden-git'),
        [`${scanRoot}/.git/hidden-git`]: dir('.beads'),
        [`${scanRoot}/.git/hidden-git/.beads`]: [],
        [`${scanRoot}/.claude`]: dir('worktrees'),
        [`${scanRoot}/.claude/worktrees`]: dir('wt'),
        [`${scanRoot}/.claude/worktrees/wt`]: dir('.beads'),
        [`${scanRoot}/.claude/worktrees/wt/.beads`]: [],
        [`${scanRoot}/ok`]: dir('.beads'),
        [`${scanRoot}/ok/.beads`]: [],
      },
    });

    const projects = await discoverProjects({
      fs,
      commandRunner: createFakeCommandRunner({ responses: {} }),
      config: { scanRoots: [scanRoot], maxDepth: DEFAULT_MAX_DEPTH },
    });

    expect(projects.map((p) => p.rootPath)).toEqual([`${scanRoot}/ok`]);
  });

  it('does not follow symlinked directories', async () => {
    const fs = createFakeFs({
      dirs: {
        [scanRoot]: [symlink('linked'), ...dir('real')],
        [`${scanRoot}/linked`]: dir('.beads'),
        [`${scanRoot}/linked/.beads`]: [],
        [`${scanRoot}/real`]: dir('.beads'),
        [`${scanRoot}/real/.beads`]: [],
      },
    });

    const projects = await discoverProjects({
      fs,
      commandRunner: createFakeCommandRunner({ responses: {} }),
      config: { scanRoots: [scanRoot] },
    });

    expect(projects.map((p) => p.rootPath)).toEqual([`${scanRoot}/real`]);
  });

  it('once .beads is found, does not descend below it (no double-report)', async () => {
    const fs = createFakeFs({
      dirs: {
        [scanRoot]: dir('parent'),
        [`${scanRoot}/parent`]: dir('.beads'),
        [`${scanRoot}/parent/.beads`]: dir('nested'),
        [`${scanRoot}/parent/.beads/nested`]: dir('.beads'),
        [`${scanRoot}/parent/.beads/nested/.beads`]: [],
      },
    });

    const projects = await discoverProjects({
      fs,
      commandRunner: createFakeCommandRunner({ responses: {} }),
      config: { scanRoots: [scanRoot] },
    });

    expect(projects).toHaveLength(1);
    expect(projects[0]?.rootPath).toBe(`${scanRoot}/parent`);
  });

  it('does not abort the scan when readDir throws; other candidates are still returned', async () => {
    const fs = createFakeFs({
      dirs: {
        [scanRoot]: dir('blocked', 'visible'),
        [`${scanRoot}/visible`]: dir('.beads'),
        [`${scanRoot}/visible/.beads`]: [],
      },
      throwOnRead: [`${scanRoot}/blocked`],
    });

    const projects = await discoverProjects({
      fs,
      commandRunner: createFakeCommandRunner({ responses: {} }),
      config: { scanRoots: [scanRoot] },
    });

    expect(projects.map((p) => p.rootPath)).toEqual([`${scanRoot}/visible`]);
  });

  it('worktree normalization collapses worktree and main checkout to one main-side path', async () => {
    const mainCheckout = `${scanRoot}/repos/main`;
    const worktree = `${mainCheckout}/.claude/worktrees/wt1`;

    const fs = createFakeFs({
      dirs: {
        [mainCheckout]: dir('.beads'),
        [`${mainCheckout}/.beads`]: [],
        [worktree]: dir('.beads'),
        [`${worktree}/.beads`]: [],
      },
      realPaths: {
        [mainCheckout]: mainCheckout,
        [worktree]: worktree,
      },
    });

    const commandRunner = createFakeCommandRunner({
      responses: {
        [worktree]: {
          stdout: `${mainCheckout}/.git\n`,
          stderr: '',
          exitCode: 0,
        },
        [mainCheckout]: {
          stdout: `${mainCheckout}/.git\n`,
          stderr: '',
          exitCode: 0,
        },
      },
    });

    const projects = await discoverProjects({
      fs,
      commandRunner,
      config: { scanRoots: [mainCheckout, worktree], maxDepth: 0 },
    });

    expect(projects).toHaveLength(1);
    expect(projects[0]?.rootPath).toBe(mainCheckout);
  });

  it('uses the candidate path as-is when git exits non-zero', async () => {
    const candidate = `${scanRoot}/nogit`;

    const fs = createFakeFs({
      dirs: {
        [scanRoot]: dir('nogit'),
        [candidate]: dir('.beads'),
        [`${candidate}/.beads`]: [],
      },
    });

    const projects = await discoverProjects({
      fs,
      commandRunner: createFakeCommandRunner({ responses: {} }),
      config: { scanRoots: [scanRoot] },
    });

    expect(projects).toHaveLength(1);
    expect(projects[0]?.rootPath).toBe(candidate);
  });

  it('uses the candidate path as-is when git succeeds but canonical has no .beads', async () => {
    const candidate = `${scanRoot}/worktree`;
    const canonical = `${scanRoot}/bare-no-beads`;

    const fs = createFakeFs({
      dirs: {
        [scanRoot]: dir('worktree', 'bare-no-beads'),
        [candidate]: dir('.beads'),
        [`${candidate}/.beads`]: [],
        [canonical]: dir('src'),
        [`${canonical}/src`]: [],
      },
    });

    const projects = await discoverProjects({
      fs,
      commandRunner: createFakeCommandRunner({
        responses: {
          [candidate]: {
            stdout: `${canonical}/.git\n`,
            stderr: '',
            exitCode: 0,
          },
        },
      }),
      config: { scanRoots: [scanRoot] },
    });

    expect(projects).toHaveLength(1);
    expect(projects[0]?.rootPath).toBe(candidate);
  });

  it('filters excludePaths by exact match and path-boundary prefix', async () => {
    const fs = createFakeFs({
      dirs: {
        [scanRoot]: dir('a', 'b', 'bc'),
        [`${scanRoot}/a`]: dir('b', 'bc'),
        [`${scanRoot}/a/b`]: dir('.beads'),
        [`${scanRoot}/a/b/.beads`]: [],
        [`${scanRoot}/a/bc`]: dir('.beads'),
        [`${scanRoot}/a/bc/.beads`]: [],
        [`${scanRoot}/b`]: dir('.beads'),
        [`${scanRoot}/b/.beads`]: [],
        [`${scanRoot}/bc`]: dir('.beads'),
        [`${scanRoot}/bc/.beads`]: [],
      },
    });

    const projects = await discoverProjects({
      fs,
      commandRunner: createFakeCommandRunner({ responses: {} }),
      config: {
        scanRoots: [scanRoot],
        excludePaths: [`${scanRoot}/a/b`, `${scanRoot}/b`],
      },
    });

    expect(projects.map((p) => p.rootPath)).toEqual([`${scanRoot}/a/bc`, `${scanRoot}/bc`]);
  });

  it('applies excludePaths with trailing separators (hand-edited/legacy config) to both prune and filter', async () => {
    // budget 2: 末尾スラッシュ付き exclude で prune が効かないと
    // scanRoot(1) → a(2) で予算が尽き、b が走査されず結果も [a] に化ける。
    // 正規化+刈り込みが効いていれば scanRoot(1) → b(2) で [b] になる。
    const fs = createFakeFs({
      dirs: {
        [scanRoot]: dir('a', 'b'),
        [`${scanRoot}/a`]: dir('.beads'),
        [`${scanRoot}/a/.beads`]: [],
        [`${scanRoot}/b`]: dir('.beads'),
        [`${scanRoot}/b/.beads`]: [],
      },
    });

    const logWarn = vi.fn();
    const projects = await discoverProjects({
      fs,
      commandRunner: createFakeCommandRunner({ responses: {} }),
      config: {
        scanRoots: [scanRoot],
        excludePaths: [`${scanRoot}/a/`],
        maxDirectories: 2,
      },
      logWarn,
    });

    expect(projects.map((p) => p.rootPath)).toEqual([`${scanRoot}/b`]);
    expect(logWarn).not.toHaveBeenCalled();
  });

  it('applies excludePaths across Windows path separators (bdboard-h7f)', async () => {
    const fs = createFakeFs({
      dirs: {
        'C:\\root\\proj': dir('.beads'),
        'C:\\rootother': dir('.beads'),
      },
      // realPath 既定は正準化後キー。ドライブレター付き入力は realPaths で区切りを維持 (bdboard-9dm)。
      realPaths: {
        'C:/root/proj': 'C:\\root\\proj',
        'C:/rootother': 'C:\\rootother',
      },
    });

    const projects = await discoverProjects({
      fs,
      commandRunner: createFakeCommandRunner({ responses: {} }),
      config: {
        scanRoots: ['C:\\root\\proj', 'C:\\rootother'],
        // 'C:\root' は 'C:\root\proj' の親: バックスラッシュ境界でも除外が効き、
        // 'C:\rootother' のような単なる前方一致(非境界)は除外されないこと。
        excludePaths: ['C:\\root'],
      },
    });

    expect(projects.map((p) => p.rootPath)).toEqual(['C:\\rootother']);
  });

  it('applies slash-form excludePaths to backslash-form project paths (RS1)', async () => {
    const fs = createFakeFs({
      dirs: {
        'C:\\root\\proj': dir('.beads'),
        'C:\\rootother': dir('.beads'),
      },
      // realPath 既定は正準化後キー。ドライブレター付き入力は realPaths で区切りを維持 (bdboard-9dm)。
      realPaths: {
        'C:/root/proj': 'C:\\root\\proj',
        'C:/rootother': 'C:\\rootother',
      },
    });

    const projects = await discoverProjects({
      fs,
      commandRunner: createFakeCommandRunner({ responses: {} }),
      config: {
        scanRoots: ['C:\\root\\proj', 'C:\\rootother'],
        // UI ヒントは 'C:/Users/you/projects' 形を案内する: スラッシュ形 exclude が
        // バックスラッシュ形の実パスにも境界付きで効くこと(非境界の 'C:\rootother' は残る)。
        excludePaths: ['C:/root'],
      },
    });

    expect(projects.map((p) => p.rootPath)).toEqual(['C:\\rootother']);
  });

  it('handles multiple scan roots and deduplicates duplicate scan roots', async () => {
    const otherRoot = '/other';
    const shared = `${scanRoot}/shared`;

    const fs = createFakeFs({
      dirs: {
        [scanRoot]: dir('shared', 'only-scan'),
        [otherRoot]: dir('only-other'),
        [shared]: dir('.beads'),
        [`${shared}/.beads`]: [],
        [`${scanRoot}/only-scan`]: dir('.beads'),
        [`${scanRoot}/only-scan/.beads`]: [],
        [`${otherRoot}/only-other`]: dir('.beads'),
        [`${otherRoot}/only-other/.beads`]: [],
      },
    });

    const projects = await discoverProjects({
      fs,
      commandRunner: createFakeCommandRunner({ responses: {} }),
      config: { scanRoots: [otherRoot, scanRoot, scanRoot] },
    });

    expect(projects.map((p) => p.rootPath)).toEqual([
      `${otherRoot}/only-other`,
      `${scanRoot}/only-scan`,
      shared,
    ]);
  });

  it('returns results sorted by rootPath ascending (code-point order)', async () => {
    const fs = createFakeFs({
      dirs: {
        [scanRoot]: dir('zeta', 'Alpha', 'beta'),
        [`${scanRoot}/zeta`]: dir('.beads'),
        [`${scanRoot}/zeta/.beads`]: [],
        [`${scanRoot}/Alpha`]: dir('.beads'),
        [`${scanRoot}/Alpha/.beads`]: [],
        [`${scanRoot}/beta`]: dir('.beads'),
        [`${scanRoot}/beta/.beads`]: [],
      },
    });

    const projects = await discoverProjects({
      fs,
      commandRunner: createFakeCommandRunner({ responses: {} }),
      config: { scanRoots: [scanRoot] },
    });

    expect(projects.map((p) => p.rootPath)).toEqual([
      `${scanRoot}/Alpha`,
      `${scanRoot}/beta`,
      `${scanRoot}/zeta`,
    ]);
  });

  it('collects aliasPaths when an out-of-repo worktree folds into the main checkout', async () => {
    const mainCheckout = '/r/main';
    const externalWorktree = '/w/foo';

    const fs = createFakeFs({
      dirs: {
        [externalWorktree]: dir('.beads'),
        [`${externalWorktree}/.beads`]: [],
        [mainCheckout]: dir('.beads'),
        [`${mainCheckout}/.beads`]: [],
      },
      realPaths: {
        [mainCheckout]: mainCheckout,
        [externalWorktree]: externalWorktree,
      },
    });

    const commandRunner = createFakeCommandRunner({
      responses: {
        [externalWorktree]: {
          stdout: `${mainCheckout}/.git\n`,
          stderr: '',
          exitCode: 0,
        },
      },
    });

    const projects = await discoverProjects({
      fs,
      commandRunner,
      config: { scanRoots: [externalWorktree], maxDepth: 0 },
    });

    expect(projects).toHaveLength(1);
    expect(projects[0]?.rootPath).toBe(mainCheckout);
    expect(projects[0]?.aliasPaths).toEqual([externalWorktree]);
  });

  it('sorts and deduplicates aliasPaths when multiple external worktrees fold into one main checkout', async () => {
    const mainCheckout = '/r/main';
    const worktreeA = '/w/bar';
    const worktreeB = '/w/foo';

    const fs = createFakeFs({
      dirs: {
        [worktreeA]: dir('.beads'),
        [`${worktreeA}/.beads`]: [],
        [worktreeB]: dir('.beads'),
        [`${worktreeB}/.beads`]: [],
        [mainCheckout]: dir('.beads'),
        [`${mainCheckout}/.beads`]: [],
      },
      realPaths: {
        [mainCheckout]: mainCheckout,
        [worktreeA]: worktreeA,
        [worktreeB]: worktreeB,
      },
    });

    const commandRunner = createFakeCommandRunner({
      responses: {
        [worktreeA]: {
          stdout: `${mainCheckout}/.git\n`,
          stderr: '',
          exitCode: 0,
        },
        [worktreeB]: {
          stdout: `${mainCheckout}/.git\n`,
          stderr: '',
          exitCode: 0,
        },
      },
    });

    const projects = await discoverProjects({
      fs,
      commandRunner,
      config: { scanRoots: [worktreeB, worktreeA], maxDepth: 0 },
    });

    expect(projects).toHaveLength(1);
    expect(projects[0]?.aliasPaths).toEqual([worktreeA, worktreeB]);
  });

  it('sets aliasPaths to an empty array for projects that are not folded into another root', async () => {
    const fs = createFakeFs({
      dirs: {
        [scanRoot]: dir('proj'),
        [`${scanRoot}/proj`]: dir('.beads'),
        [`${scanRoot}/proj/.beads`]: [],
      },
    });

    const projects = await discoverProjects({
      fs,
      commandRunner: createFakeCommandRunner({ responses: {} }),
      config: { scanRoots: [scanRoot] },
    });

    expect(projects[0]?.aliasPaths).toEqual([]);
  });

  it('aborts the walk once maxDirectories is exceeded, returns partial results, and warns', async () => {
    // scanRoot(1) → a(2) → a/proj(3) で上限3に達し、b 以下は訪問されない。
    // ディレクトリ名はソート順(compareStrings)で a が先に走査される前提。
    const fs = createFakeFs({
      dirs: {
        [scanRoot]: dir('a', 'b'),
        [`${scanRoot}/a`]: dir('proj'),
        [`${scanRoot}/a/proj`]: dir('.beads'),
        [`${scanRoot}/a/proj/.beads`]: [],
        [`${scanRoot}/b`]: dir('proj'),
        [`${scanRoot}/b/proj`]: dir('.beads'),
        [`${scanRoot}/b/proj/.beads`]: [],
      },
    });

    const logWarn = vi.fn();
    const projects = await discoverProjects({
      fs,
      commandRunner: createFakeCommandRunner({ responses: {} }),
      config: { scanRoots: [scanRoot], maxDirectories: 3 },
      logWarn,
    });

    expect(projects.map((p) => p.rootPath)).toEqual([`${scanRoot}/a/proj`]);
    expect(logWarn).toHaveBeenCalledOnce();
    expect(logWarn.mock.calls[0]?.[0]).toContain('partial');
  });

  it('names every root that was not fully scanned in the warning (shared budget, sort order)', async () => {
    // '/aaa'(2 dirs) を走査し切った後 '/scan' の途中で予算が尽きる。
    // 警告には走査しきれなかった '/scan' と、その後まったく走査されない '/zzz' が載り、
    // 完走した '/aaa' は載らない。
    const fs = createFakeFs({
      dirs: {
        '/aaa': dir('done'),
        '/aaa/done': dir('.beads'),
        '/aaa/done/.beads': [],
        [scanRoot]: dir('a', 'b'),
        [`${scanRoot}/a`]: dir('.beads'),
        [`${scanRoot}/a/.beads`]: [],
        [`${scanRoot}/b`]: dir('.beads'),
        [`${scanRoot}/b/.beads`]: [],
        '/zzz': dir('never'),
        '/zzz/never': dir('.beads'),
        '/zzz/never/.beads': [],
      },
    });

    const logWarn = vi.fn();
    const projects = await discoverProjects({
      fs,
      commandRunner: createFakeCommandRunner({ responses: {} }),
      config: { scanRoots: ['/zzz', scanRoot, '/aaa'], maxDirectories: 4 },
      logWarn,
    });

    expect(projects.map((p) => p.rootPath)).toEqual(['/aaa/done', `${scanRoot}/a`]);
    expect(logWarn).toHaveBeenCalledOnce();
    const message = logWarn.mock.calls[0]?.[0] as string;
    expect(message).toContain(`Roots not fully scanned: ${scanRoot}, /zzz`);
    expect(message).not.toContain('/aaa');
  });

  it('does not warn when the walk stays under the default directory limit', async () => {
    const fs = createFakeFs({
      dirs: {
        [scanRoot]: dir('proj'),
        [`${scanRoot}/proj`]: dir('.beads'),
        [`${scanRoot}/proj/.beads`]: [],
      },
    });

    const logWarn = vi.fn();
    const projects = await discoverProjects({
      fs,
      commandRunner: createFakeCommandRunner({ responses: {} }),
      config: { scanRoots: [scanRoot] },
      logWarn,
    });

    expect(projects).toHaveLength(1);
    expect(logWarn).not.toHaveBeenCalled();
  });

  it('falls back to the default limit when maxDirectories is zero or negative', async () => {
    const fs = createFakeFs({
      dirs: {
        [scanRoot]: dir('proj'),
        [`${scanRoot}/proj`]: dir('.beads'),
        [`${scanRoot}/proj/.beads`]: [],
      },
    });

    for (const maxDirectories of [0, -1]) {
      const logWarn = vi.fn();
      const projects = await discoverProjects({
        fs,
        commandRunner: createFakeCommandRunner({ responses: {} }),
        config: { scanRoots: [scanRoot], maxDirectories },
        logWarn,
      });

      expect(projects).toHaveLength(1);
      expect(logWarn).not.toHaveBeenCalled();
    }
  });

  it('prunes excludePaths during the walk so they do not consume the directory budget', async () => {
    // budget 3: excluded(巨大サブツリー想定) が刈り込まれず訪問されると
    // scanRoot(1) → excluded(2) → excluded/deep(3) で予算が尽き ok/proj に届かない。
    // 刈り込みが効いていれば scanRoot(1) → ok(2) → ok/proj(3)... の順で見つかる。
    const excluded = `${scanRoot}/excluded`;
    const fs = createFakeFs({
      dirs: {
        [scanRoot]: dir('excluded', 'ok'),
        [excluded]: dir('deep'),
        [`${excluded}/deep`]: dir('deeper'),
        [`${excluded}/deep/deeper`]: [],
        [`${scanRoot}/ok`]: dir('proj'),
        [`${scanRoot}/ok/proj`]: dir('.beads'),
        [`${scanRoot}/ok/proj/.beads`]: [],
      },
    });

    const logWarn = vi.fn();
    const projects = await discoverProjects({
      fs,
      commandRunner: createFakeCommandRunner({ responses: {} }),
      config: { scanRoots: [scanRoot], excludePaths: [excluded], maxDirectories: 3 },
      logWarn,
    });

    expect(projects.map((p) => p.rootPath)).toEqual([`${scanRoot}/ok/proj`]);
    expect(logWarn).not.toHaveBeenCalled();
  });

  it('sets prefixes to an empty array (filled in S3)', async () => {
    const fs = createFakeFs({
      dirs: {
        [scanRoot]: dir('proj'),
        [`${scanRoot}/proj`]: dir('.beads'),
        [`${scanRoot}/proj/.beads`]: [],
      },
    });

    const projects = await discoverProjects({
      fs,
      commandRunner: createFakeCommandRunner({ responses: {} }),
      config: { scanRoots: [scanRoot] },
    });

    expect(projects[0]?.prefixes).toEqual([]);
  });
});
