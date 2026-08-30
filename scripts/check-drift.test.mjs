import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'check-drift.mjs');

/** 改名前後で git の類似度検出が効く程度に大きいファイル。 */
const BIG_FILE = (marker) =>
  `${Array.from({ length: 40 }, (_, i) => `export const line${i} = ${i};`).join('\n')}\nexport const marker = ${marker};\n`;
import { computeDrift, formatDriftReport } from './check-drift.mjs';

const CTX = {
  mergeBase: '0123456789abcdef',
  upstream: 'origin/main',
  aheadCount: 5,
};

describe('computeDrift', () => {
  it('returns only the files both sides touched', () => {
    const drift = computeDrift(
      ['web/src/components/StatusPill.tsx', 'web/src/index.css', 'src/main.ts'],
      ['web/src/index.css', 'web/src/components/StatusPill.tsx', 'docs/PLAN.md'],
    );

    expect(drift.overlap).toEqual([
      'web/src/components/StatusPill.tsx',
      'web/src/index.css',
    ]);
    expect(drift.mainFileCount).toBe(3);
    expect(drift.branchFileCount).toBe(3);
  });

  it('keeps the upstream ordering rather than the branch ordering', () => {
    // 出力は git の並び (パス辞書順) で読まれる前提。ブランチ側の順に引きずられると
    // 実行ごとに並びが変わって差分が読みにくくなる。
    const drift = computeDrift(['a.ts', 'b.ts'], ['b.ts', 'a.ts']);
    expect(drift.overlap).toEqual(['a.ts', 'b.ts']);
  });

  it('is empty when the two sides touch disjoint files', () => {
    const drift = computeDrift(['src/a.ts'], ['src/b.ts']);
    expect(drift.overlap).toEqual([]);
    expect(drift.mainFileCount).toBe(1);
    expect(drift.branchFileCount).toBe(1);
  });

  it('does not report the same file twice', () => {
    // git diff --name-only は重複を出さないが、集合演算をリストの filter で書くと
    // 入力が重複した瞬間に件数が水増しされる。件数はレポートの見出しに出るので、
    // ここが狂うと「2件」と言いながら1ファイルしか並ばない表示になる。
    const drift = computeDrift(['src/a.ts', 'src/a.ts'], ['src/a.ts']);
    expect(drift.overlap).toEqual(['src/a.ts']);
    expect(drift.mainFileCount).toBe(1);
  });

  it('handles either side being empty', () => {
    expect(computeDrift([], ['src/a.ts']).overlap).toEqual([]);
    expect(computeDrift(['src/a.ts'], []).overlap).toEqual([]);
    expect(computeDrift([], []).branchFileCount).toBe(0);
  });
});

describe('formatDriftReport', () => {
  it('names every overlapping file and the rebase command', () => {
    const report = formatDriftReport(
      computeDrift(['web/src/index.css'], ['web/src/index.css']),
      CTX,
    );

    expect(report).toContain('origin/main は 5 コミット進んでいます');
    expect(report).toContain('1 件あります');
    expect(report).toContain('  web/src/index.css');
    expect(report).toContain('git rebase origin/main');
  });

  it('says so explicitly when nothing overlaps', () => {
    const report = formatDriftReport(computeDrift(['a.ts'], ['b.ts']), CTX);

    expect(report).toContain('重なるファイルはありません');
    // 件数を添えるのは「0件」と「比較材料が無い」を読み手が区別できるようにするため。
    expect(report).toContain('origin/main 側 1 ファイル / ブランチ側 1 ファイル');
    expect(report).not.toContain('git rebase');
  });

  it('distinguishes an unmoved upstream from a genuine zero overlap', () => {
    const report = formatDriftReport(computeDrift([], ['a.ts']), {
      ...CTX,
      aheadCount: 0,
    });

    expect(report).toContain('重なりようがありません');
    expect(report).not.toContain('重なるファイルはありません');
  });

  it('distinguishes an untouched branch from a genuine zero overlap', () => {
    const report = formatDriftReport(computeDrift(['a.ts'], []), CTX);

    expect(report).toContain('まだファイルを変更していません');
    expect(report).not.toContain('重なるファイルはありません');
  });

  it('never tells the caller it is a verdict', () => {
    // 「衝突する」と断言すると、ハンクが離れていて実際は衝突しないケースで
    // 信用を失う。常に exit 0 で返すのと同じ理由。
    const report = formatDriftReport(computeDrift(['a.ts'], ['a.ts']), CTX);
    expect(report).toContain('上界であって判定ではありません');
  });
});

/*
 * ここから下は main() の配線 = 実際に git を叩く側のテスト。
 *
 * 上の純関数テストは10件とも通っていたのに、fable レビューは配線側に実バグを2件
 * 見つけた (rename で重なりが消える / パスに空白があると main() が走らない)。
 * 「pure 関数だけ見ておけばよい」が成り立たなかったので、使い捨てリポジトリを作って
 * 実際に走らせる層を足す。verify-slot.test.mjs が subprocess を起こす前例。
 */
describe('check-drift CLI', () => {
  let tmpRoot;

  function sh(cwd, ...args) {
    return execFileSync(args[0], args.slice(1), {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@e', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@e' },
    });
  }

  /** bare remote + クローン1つ。クローンの scripts/ に本体をコピーして返す。 */
  function makeRepo(name) {
    const bare = path.join(tmpRoot, `${name}.git`);
    const work = path.join(tmpRoot, name);
    fs.mkdirSync(bare, { recursive: true });
    sh(tmpRoot, 'git', 'init', '--bare', '-b', 'main', bare);
    sh(tmpRoot, 'git', 'clone', '-q', bare, work);
    fs.mkdirSync(path.join(work, 'scripts'), { recursive: true });
    fs.copyFileSync(SCRIPT_PATH, path.join(work, 'scripts', 'check-drift.mjs'));
    // rename 検出は類似度で効くので、中身が1行だと改名しても delete+add 扱いになり
    // --no-renames の有無が観測できない。十分な行数を持たせる。
    fs.writeFileSync(path.join(work, 'hot.ts'), BIG_FILE('1'));
    sh(work, 'git', 'add', '-A');
    sh(work, 'git', 'commit', '-qm', 'base');
    sh(work, 'git', 'push', '-q', 'origin', 'main');
    return { bare, work };
  }

  /** main を進める。クローンをもう1つ作って push する。 */
  function advanceMain(bare, name, mutate) {
    const other = path.join(tmpRoot, `${name}-peer`);
    sh(tmpRoot, 'git', 'clone', '-q', bare, other);
    mutate(other, (...a) => sh(other, ...a));
    sh(other, 'git', 'add', '-A');
    sh(other, 'git', 'commit', '-qm', 'peer');
    sh(other, 'git', 'push', '-q', 'origin', 'main');
    sh(other, 'git', 'fetch', '-q', 'origin');
  }

  function runDrift(work) {
    const result = spawnSync(process.execPath, ['scripts/check-drift.mjs', '--no-fetch'], {
      cwd: work,
      encoding: 'utf8',
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-cli-'));
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  // bdboard-z4h0: Windows runner の git 操作は稀に既定の5000msタイムアウトを
  // 超えることがある(bdboard-s0yv/PR#226, bdboard-f1c9/PR#236 で2回観測)。
  // makeRepo/advanceMain が実ファイルシステム上でbareリポジトリの
  // git init/commit/push を行うため、このテストだけI/Oが重い。
  it(
    'names the file when both sides edited it',
    () => {
      const { bare, work } = makeRepo('both');
      advanceMain(bare, 'both', (dir) => {
        fs.writeFileSync(path.join(dir, 'hot.ts'), BIG_FILE('2'));
      });
      sh(work, 'git', 'fetch', '-q', 'origin');
      sh(work, 'git', 'checkout', '-qb', 'feature');
      fs.writeFileSync(path.join(work, 'hot.ts'), BIG_FILE('3'));
      sh(work, 'git', 'commit', '-qam', 'mine');

      const { status, stdout } = runDrift(work);
      expect(stdout).toContain('hot.ts');
      expect(status).toBe(0);
    },
    15000,
  );

  // bdboard-8r5b: 上の「両側編集」と同じ makeRepo/advanceMain 負荷。観測は未だが
  // 同等の flake リスクがあるため同じ per-test タイムアウトを付ける。
  it(
    'still names the file when the upstream renamed it',
    () => {
      // rename 検出が効いていると main 側は新パスしか出さず、旧パスを触っている
      // ブランチとの重なりが消える。実際に rebase すると衝突するので、
      // 「重なりは上界」という前提そのものが破れる。--no-renames を外すと落ちる。
      const { bare, work } = makeRepo('rename');
      advanceMain(bare, 'rename', (dir, run) => {
        run('git', 'mv', 'hot.ts', 'renamed-hot.ts');
        fs.writeFileSync(path.join(dir, 'renamed-hot.ts'), BIG_FILE('2'));
      });
      sh(work, 'git', 'fetch', '-q', 'origin');
      sh(work, 'git', 'checkout', '-qb', 'feature');
      fs.writeFileSync(path.join(work, 'hot.ts'), BIG_FILE('3'));
      sh(work, 'git', 'commit', '-qam', 'mine');

      const { status, stdout } = runDrift(work);
      // 旧パスで名指しされること。--no-renames を外すと renamed-hot.ts しか出ず、
      // 「重なるファイルはありません」になる。
      expect(stdout).toContain('  hot.ts');
      expect(stdout).not.toContain('重なるファイルはありません');
      expect(status).toBe(0);
    },
    15000,
  );

  it('exits 2 without a report when the check cannot run at all', () => {
    // merge-base が取れない = 調べられていない。0 で返すと、stdout だけ見ている
    // 呼び出し側から「調べて問題なし」と区別が付かない。
    const { work } = makeRepo('orphan');
    sh(work, 'git', 'remote', 'remove', 'origin');

    const { status, stdout } = runDrift(work);
    expect(status).toBe(2);
    expect(stdout).toBe('');
  });

  it('runs even when the repository path contains a space', () => {
    // `file://${argv[1]}` 比較だと import.meta.url 側だけ %20 になって一致せず、
    // main() が走らないまま無言で exit 0 になる。いちばん質の悪い黙り方。
    const spaced = path.join(tmpRoot, 'has space');
    fs.mkdirSync(spaced, { recursive: true });
    const bare = path.join(spaced, 'r.git');
    const work = path.join(spaced, 'r');
    sh(spaced, 'git', 'init', '--bare', '-b', 'main', bare);
    sh(spaced, 'git', 'clone', '-q', bare, work);
    fs.mkdirSync(path.join(work, 'scripts'), { recursive: true });
    fs.copyFileSync(SCRIPT_PATH, path.join(work, 'scripts', 'check-drift.mjs'));
    fs.writeFileSync(path.join(work, 'hot.ts'), 'x\n');
    sh(work, 'git', 'add', '-A');
    sh(work, 'git', 'commit', '-qm', 'base');
    sh(work, 'git', 'push', '-q', 'origin', 'main');
    sh(work, 'git', 'checkout', '-qb', 'feature');
    fs.writeFileSync(path.join(work, 'hot.ts'), 'y\n');
    sh(work, 'git', 'commit', '-qam', 'mine');

    const { stdout } = runDrift(work);
    expect(stdout).not.toBe('');
    expect(stdout).toContain('drift:');
  });
});
