import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'check-drift.mjs');
const FAKE_GH_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-gh.mjs');

/** 改名前後で git の類似度検出が効く程度に大きいファイル。 */
const BIG_FILE = (marker) =>
  `${Array.from({ length: 40 }, (_, i) => `export const line${i} = ${i};`).join('\n')}\nexport const marker = ${marker};\n`;

/**
 * bdboard-b0yd R2-2 用: 先頭行 (hot line) と末尾行 (marker) を独立に変えられる
 * ファイル。二つの変更行の間に十分な行数を挟むことで、git の (ort ベースの)
 * マージが両者を別ハンクとして扱い、片方だけの衝突を再現できるようにする。
 */
const HOT_LINE_FILE = (hotLine, marker) =>
  `export const hot = ${JSON.stringify(hotLine)};\n${Array.from(
    { length: 10 },
    (_, i) => `export const filler${i} = ${i};`,
  ).join('\n')}\nexport const marker = ${JSON.stringify(marker)};\n`;
import {
  computeDrift,
  formatDriftReport,
  parseMergeTreeConflictFiles,
} from './check-drift.mjs';

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

describe('merge-tree conflict output parser', () => {
  it('returns no files for clean output', () => {
    expect(parseMergeTreeConflictFiles('0123456789abcdef0123456789abcdef01234567\n')).toEqual([]);
  });

  it('keeps only paths from a real conflict output shape', () => {
    expect(
      parseMergeTreeConflictFiles(
        [
          '44dc16ff519b690e19ded163060aae876c0de157',
          'a.txt',
          'b.bin',
          'docs/日本語.md',
          'f.txt',
          '',
          'CONFLICT (modify/delete): a.txt deleted in p1 and modified in main.  Version main of a.txt left in tree.',
          'warning: Cannot merge binary files: b.bin (main vs. p1)',
          'Auto-merging b.bin',
          'CONFLICT (content): Merge conflict in b.bin',
          'Auto-merging docs/日本語.md',
          'CONFLICT (content): Merge conflict in docs/日本語.md',
          'Auto-merging f.txt',
          'CONFLICT (content): Merge conflict in f.txt',
          '',
        ].join('\n'),
      ),
    ).toEqual(['a.txt', 'b.bin', 'docs/日本語.md', 'f.txt']);
  });

  it('passes a C-quoted path through as one path line', () => {
    expect(
      parseMergeTreeConflictFiles(
        '0123456789abcdef0123456789abcdef01234567\n"docs/\\346\\227\\245\\346\\234\\254\\350\\252\\236.md"\n\nCONFLICT (content): Merge conflict\n',
      ),
    ).toEqual(['"docs/\\346\\227\\245\\346\\234\\254\\350\\252\\236.md"']);
  });

  it('ignores localized informational messages after the structural boundary', () => {
    expect(
      parseMergeTreeConflictFiles(
        '0123456789abcdef0123456789abcdef01234567\nb.bin\n\nautomatischer Merge von b.bin\nKONFLIKT (Inhalt): Merge-Konflikt in b.bin\n',
      ),
    ).toEqual(['b.bin']);
  });

  it('uses only the first blank line even when an informational message contains blank lines', () => {
    expect(
      parseMergeTreeConflictFiles(
        '0123456789abcdef0123456789abcdef01234567\nf.txt\n\nCONFLICT (content): first line\n\nembedded continuation\n',
      ),
    ).toEqual(['f.txt']);
  });

  it('preserves leading and trailing spaces in paths', () => {
    expect(
      parseMergeTreeConflictFiles(
        '0123456789abcdef0123456789abcdef01234567\n leading.txt\ntrailing.txt \r\n\nCONFLICT\n',
      ),
    ).toEqual([' leading.txt', 'trailing.txt ']);
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
  // bdboard-b0yd R2-3: `git merge-base --is-ancestor` で peer の新旧が分かるので、
  // バケットC (衝突パスが自分のファイル外) はもう両論併記しない。peer が
  // origin/main を取り込み済みなら rename、そうでなければ peer 自身の
  // stale-main 衝突と断定できる。
  const renameConflictExplanation =
    'peer 側の rename によるパス名のずれによる衝突の可能性があります。実物を確認してください。';
  const staleMainConflictExplanation =
    'peer 自身が origin/main に対して古いため、この衝突は peer 側の rebase で解消する可能性が高いです。';
  // bdboard-b0yd R4-A/B: 自分自身が origin/main に対して stale なときの文言。
  // 階層1 (conflicts) とバケットC (conflictsOutsideBranchFiles) で文面が違う。
  const layer1SelfStaleExplanation =
    'このブランチが origin/main に対して古いため、main との drift が混ざっている可能性があります。まず rebase してから再実行してください';
  const bucketCSelfStaleExplanation =
    'このブランチが origin/main に対して古いため、この衝突の原因を peer 側と切り分けられません。まず rebase してから再実行してください。';

  // bdboard-b0yd R4-C: check-drift.mjs の `git()` には gh のような差し替え
  // フックが無い。merge-tree だけを失敗させる回帰テストのため、本物の git の
  // 絶対パスを一度だけ調べておき、偽の `git` から delegate できるようにする。
  const REAL_GIT = execFileSync(
    process.platform === 'win32' ? 'where' : 'which',
    ['git'],
    { encoding: 'utf8' },
  )
    .trim()
    .split(/\r?\n/)[0];

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

  function runDrift(
    work,
    gh = { status: 0, output: '[]', stderr: '' },
    { noFetch = true, extraEnv = {} } = {},
  ) {
    // 実 gh は呼ばない。CLI 配線テストはネットワーク状態に依存させず、gh の成功・
    // 非ゼロ終了・壊れた JSON を scripts/fake-gh.mjs で再現する。
    //
    // bdboard-b0yd R2-1: 以前は PATH の先頭に偽の `gh` シェルスクリプトを置く
    // 方式で、`PATH: `${bin}:${process.env.PATH}`` の区切り文字 `:` が
    // Windows (`;`) で機能せず本物の gh.exe が実行されていた。ここでは PATH
    // 解決を経由せず、check-drift.mjs 側の `BDBOARD_DRIFT_GH` /
    // `BDBOARD_DRIFT_GH_ARGS` フックを使って `node fake-gh.mjs ...` を直接
    // 指定する。全プラットフォームで同じ経路を通る。
    //
    // bdboard-b0yd R4-C: check-drift.mjs 自身の `git` 呼び出しには gh のような
    // 差し替えフックが無い。merge-tree だけを失敗させる回帰テスト用に、
    // `extraEnv.PATH` で偽の `git` を先頭に置けるようにする (詳細はそのテスト
    // 自身のコメント参照)。
    const argsFile = path.join(work, 'gh-args.txt');
    const args = ['scripts/check-drift.mjs'];
    if (noFetch) {
      args.push('--no-fetch');
    }
    const result = spawnSync(process.execPath, args, {
      cwd: work,
      encoding: 'utf8',
      env: {
        ...process.env,
        ...extraEnv,
        BDBOARD_DRIFT_GH: process.execPath,
        BDBOARD_DRIFT_GH_ARGS: JSON.stringify([FAKE_GH_PATH]),
        BDBOARD_DRIFT_FAKE_GH_ARGS_FILE: argsFile,
        BDBOARD_DRIFT_FAKE_GH_STDOUT: gh.output,
        BDBOARD_DRIFT_FAKE_GH_STDERR: gh.stderr ?? '',
        BDBOARD_DRIFT_FAKE_GH_EXIT_CODE: String(gh.status),
      },
    });
    const ghArgs = fs.existsSync(argsFile)
      ? fs.readFileSync(argsFile, 'utf8').trimEnd().split('\n').filter((line) => line !== '')
      : [];
    return { status: result.status, stdout: result.stdout, stderr: result.stderr, ghArgs };
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

  it(
    'reports a broken gh invocation on both streams and preserves the successful drift exit code',
    () => {
      const { bare, work } = makeRepo('gh-failure');
      advanceMain(bare, 'gh-failure', (dir) => {
        fs.writeFileSync(path.join(dir, 'hot.ts'), BIG_FILE('2'));
      });
      sh(work, 'git', 'fetch', '-q', 'origin');
      sh(work, 'git', 'checkout', '-qb', 'feature');
      fs.writeFileSync(path.join(work, 'hot.ts'), BIG_FILE('3'));
      sh(work, 'git', 'commit', '-qam', 'mine');

      const { status, stdout, stderr } = runDrift(work, {
        status: 1,
        output: '',
        stderr: 'not authenticated\ntry gh auth login',
      });
      expect(status).toBe(0);
      expect(stdout).toContain('open PR を取得できなかったため');
      expect(stdout).toContain('not authenticated try gh auth login');
      expect(stderr).toContain('open PR を取得できなかったため');
      expect(stderr).toContain('not authenticated try gh auth login');
    },
    15000,
  );

  // bdboard-b0yd R2-7: このブランチがまだ何も変更していない (worktree 作成直後)
  // ときは branchFiles=[] で階層1の交差が定義上つねに空になり、stale な peer が
  // 1本でもあればバケットC (「ファイルの外」) が100%発火してノイズになる。
  // 比較そのものに材料が無いので、gh すら呼ばずに畳む。
  it(
    'does not compare open PRs when this branch has not changed any files yet',
    () => {
      const { work } = makeRepo('no-commits-yet');
      // main のまま何もコミットしない = branchFiles は空のまま
      // (main() の「HEAD が merge-base そのものです」分岐に入る)。

      const { status, stdout, ghArgs } = runDrift(work, {
        status: 0,
        output: JSON.stringify([
          { number: 30, headRefName: 'whatever', isCrossRepository: false },
        ]),
      });
      expect(status).toBe(0);
      expect(stdout).toContain('open PR との比較は省略しました');
      // gh 自体を呼んでいないことを、代役に渡された引数の不在で確認する。
      expect(ghArgs).toEqual([]);
    },
    15000,
  );

  it(
    'does not compare its own PR and summarizes a missing remote-tracking branch',
    () => {
      const { work } = makeRepo('own-pr');
      sh(work, 'git', 'checkout', '-qb', 'feature');
      fs.writeFileSync(path.join(work, 'hot.ts'), BIG_FILE('2'));
      sh(work, 'git', 'commit', '-qam', 'mine');

      const { status, stdout, ghArgs } = runDrift(work, {
        status: 0,
        output: JSON.stringify([
          { number: 10, headRefName: 'feature', isCrossRepository: false },
          { number: 11, headRefName: 'not-fetched', isCrossRepository: false },
        ]),
      });
      expect(status).toBe(0);
      expect(stdout).toContain('比較できた open PR がありません');
      expect(stdout).not.toContain('open PR 0 件との重なりはありません');
      expect(stdout).toContain('PR #11');
      expect(stdout).not.toContain('PR #10');
      expect(ghArgs).toContain('--limit');
      expect(ghArgs[ghArgs.indexOf('--limit') + 1]).toBe('100');
      expect(ghArgs).toContain('number,headRefName,isCrossRepository');
    },
    15000,
  );

  it(
    'rejects gh JSON that omits the cross-repository flag',
    () => {
      const { work } = makeRepo('gh-json-shape');
      sh(work, 'git', 'checkout', '-qb', 'feature');
      fs.writeFileSync(path.join(work, 'mine.ts'), 'mine\n');
      sh(work, 'git', 'add', 'mine.ts');
      sh(work, 'git', 'commit', '-qm', 'mine');

      const { status, stdout } = runDrift(work, {
        status: 0,
        output: JSON.stringify([{ number: 20, headRefName: 'peer' }]),
      });
      expect(status).toBe(0);
      expect(stdout).toContain('open PR を取得できなかったため');
      expect(stdout).toContain('unexpected gh JSON');
    },
    15000,
  );

  it(
    'skips fork pull requests instead of resolving their branch name on origin',
    () => {
      const { work } = makeRepo('fork-pr');
      sh(work, 'git', 'checkout', '-qb', 'feature');
      fs.writeFileSync(path.join(work, 'mine.ts'), 'mine\n');
      sh(work, 'git', 'add', 'mine.ts');
      sh(work, 'git', 'commit', '-qm', 'mine');

      const { status, stdout } = runDrift(work, {
        status: 0,
        output: JSON.stringify([
          { number: 21, headRefName: 'main', isCrossRepository: true },
        ]),
      });
      expect(status).toBe(0);
      expect(stdout).toContain('比較できた open PR がありません');
      expect(stdout).toContain('fork 由来の PR は比較から除外しました (PR #21)');
      expect(stdout).not.toContain('open PR #21 (main) と衝突します');
    },
    15000,
  );

  it(
    'fetches peer branches before comparing so a newly grown peer is not missed',
    () => {
      const { bare, work } = makeRepo('fresh-peer-ref');
      sh(work, 'git', 'checkout', '-qb', 'feature');
      fs.writeFileSync(path.join(work, 'shared.ts'), 'mine\n');
      sh(work, 'git', 'add', 'shared.ts');
      sh(work, 'git', 'commit', '-qm', 'mine');

      const peer = path.join(tmpRoot, 'fresh-peer-ref-peer');
      sh(tmpRoot, 'git', 'clone', '-q', bare, peer);
      sh(peer, 'git', 'checkout', '-qb', 'peer');
      fs.writeFileSync(path.join(peer, 'first.ts'), 'first\n');
      sh(peer, 'git', 'add', 'first.ts');
      sh(peer, 'git', 'commit', '-qm', 'first peer commit');
      sh(peer, 'git', 'push', '-q', 'origin', 'peer');
      sh(work, 'git', 'fetch', '-q', 'origin', 'peer');

      fs.writeFileSync(path.join(peer, 'shared.ts'), 'peer\n');
      sh(peer, 'git', 'add', 'shared.ts');
      sh(peer, 'git', 'commit', '-qm', 'peer grew');
      sh(peer, 'git', 'push', '-q', 'origin', 'peer');

      const { status, stdout } = runDrift(
        work,
        {
          status: 0,
          output: JSON.stringify([
            { number: 22, headRefName: 'peer', isCrossRepository: false },
          ]),
        },
        { noFetch: false },
      );
      expect(status).toBe(0);
      expect(stdout).toContain('open PR #22 (peer) と衝突します');
      expect(stdout).toContain('  shared.ts');
    },
    15000,
  );

  it(
    'reports a peer fetch failure on stdout and continues with an existing tracking ref',
    () => {
      const { bare, work } = makeRepo('peer-fetch-failure');
      sh(work, 'git', 'checkout', '-qb', 'feature');
      fs.writeFileSync(path.join(work, 'hot.ts'), BIG_FILE('mine'));
      sh(work, 'git', 'commit', '-qam', 'mine');

      const peer = path.join(tmpRoot, 'peer-fetch-failure-peer');
      sh(tmpRoot, 'git', 'clone', '-q', bare, peer);
      sh(peer, 'git', 'checkout', '-qb', 'peer');
      fs.writeFileSync(path.join(peer, 'hot.ts'), BIG_FILE('peer'));
      sh(peer, 'git', 'commit', '-qam', 'peer');
      sh(peer, 'git', 'push', '-q', 'origin', 'peer');
      sh(work, 'git', 'fetch', '-q', 'origin', 'peer');
      sh(work, 'git', 'remote', 'set-url', 'origin', path.join(tmpRoot, 'missing.git'));

      const { status, stdout } = runDrift(
        work,
        {
          status: 0,
          output: JSON.stringify([
            { number: 25, headRefName: 'peer', isCrossRepository: false },
          ]),
        },
        { noFetch: false },
      );
      expect(status).toBe(0);
      expect(stdout).toContain('open PR のブランチを fetch できませんでした');
      expect(stdout).toContain('open PR #25 (peer) と衝突します');
      expect(stdout).toContain('  hot.ts');
    },
    15000,
  );

  // bdboard-b0yd R2-4: 実測 (`/tmp` の使い捨てリポジトリ) — `git fetch origin
  // peerA peerB --quiet` は peerB が削除済みだと exit 128 で **peerA も**
  // 更新されない。`git fetch origin --quiet` (refspec を並べない全体 fetch) なら
  // peerB が無くてもエラーにならず、peerA だけ正しく更新される。この repo の
  // マージ手順 (`gh pr merge --squash --delete-branch`) は drift 直前に走るため、
  // `gh pr list` と fetch の間 (約1秒) に並列セッションがマージ+ブランチ削除を
  // 終える競合は現実に起きる。
  it(
    'still updates the surviving peer ref when another listed peer branch was deleted',
    () => {
      const { bare, work } = makeRepo('two-peer-one-deleted');
      sh(work, 'git', 'checkout', '-qb', 'feature');
      fs.writeFileSync(path.join(work, 'shared.ts'), 'mine\n');
      sh(work, 'git', 'add', 'shared.ts');
      sh(work, 'git', 'commit', '-qm', 'mine');

      const peerA = path.join(tmpRoot, 'two-peer-one-deleted-a');
      sh(tmpRoot, 'git', 'clone', '-q', bare, peerA);
      sh(peerA, 'git', 'checkout', '-qb', 'peerA');
      fs.writeFileSync(path.join(peerA, 'shared.ts'), 'peer A\n');
      sh(peerA, 'git', 'add', 'shared.ts');
      sh(peerA, 'git', 'commit', '-qm', 'peer A edits shared.ts');
      sh(peerA, 'git', 'push', '-q', 'origin', 'peerA');

      const peerB = path.join(tmpRoot, 'two-peer-one-deleted-b');
      sh(tmpRoot, 'git', 'clone', '-q', bare, peerB);
      sh(peerB, 'git', 'checkout', '-qb', 'peerB');
      fs.writeFileSync(path.join(peerB, 'other.ts'), 'peer B\n');
      sh(peerB, 'git', 'add', 'other.ts');
      sh(peerB, 'git', 'commit', '-qm', 'peer B');
      sh(peerB, 'git', 'push', '-q', 'origin', 'peerB');
      // gh pr list ではまだ見えているが、fetch の直前に他セッションがマージして
      // ブランチを消した、という競合状態を再現する。
      sh(peerB, 'git', 'push', '-q', 'origin', '--delete', 'peerB');

      const { status, stdout } = runDrift(
        work,
        {
          status: 0,
          output: JSON.stringify([
            { number: 26, headRefName: 'peerA', isCrossRepository: false },
            { number: 27, headRefName: 'peerB', isCrossRepository: false },
          ]),
        },
        { noFetch: false },
      );
      expect(status).toBe(0);
      // peerB が消えていても fetch 全体は失敗しない (劣化メッセージが出ない)。
      expect(stdout).not.toContain('open PR のブランチを fetch できませんでした');
      // peerA は正しく最新化され、shared.ts の重なりが検出できる。
      expect(stdout).toContain('open PR #26 (peerA)');
      expect(stdout).toContain('  shared.ts');
      // peerB はそもそも ref が存在しない (fetch できるはずがない) ので、
      // 個別に「リモート追跡ブランチがない」に落ちる。
      expect(stdout).toContain('リモート追跡ブランチがないため比較を省略しました (PR #27)');
    },
    15000,
  );

  it(
    'reports a merge-tree conflict as the stronger signal without a duplicate file-level warning',
    () => {
      const { bare, work } = makeRepo('peer-conflict');
      sh(work, 'git', 'checkout', '-qb', 'feature');
      fs.writeFileSync(path.join(work, 'hot.ts'), BIG_FILE('mine'));
      sh(work, 'git', 'commit', '-qam', 'mine');

      const peer = path.join(tmpRoot, 'peer-conflict-peer');
      sh(tmpRoot, 'git', 'clone', '-q', bare, peer);
      sh(peer, 'git', 'checkout', '-qb', 'peer');
      fs.writeFileSync(path.join(peer, 'hot.ts'), BIG_FILE('peer'));
      sh(peer, 'git', 'commit', '-qam', 'peer');
      sh(peer, 'git', 'push', '-q', 'origin', 'peer');
      sh(work, 'git', 'fetch', '-q', 'origin');

      const { status, stdout } = runDrift(work, {
        status: 0,
        output: JSON.stringify([
          { number: 12, headRefName: 'peer', isCrossRepository: false },
        ]),
      });
      expect(status).toBe(0);
      expect(stdout).toContain('open PR #12 (peer) と衝突します');
      expect(stdout).toContain('  hot.ts');
      expect(stdout).not.toContain('open PR #12 (peer) と同じファイルを触っています');
    },
    15000,
  );

  // bdboard-b0yd R2-6: mergeTree() の `-c core.quotepath=false` に対する CLI 級の
  // 回帰テスト。既存のパーサテストは手作りの文字列しか見ておらず、mergeTree() から
  // フラグを外しても赤くならなかった。ここでは実際に非ASCIIパスを両側で追加して
  // add/add 衝突させ、changedFiles() 側 (常に quotepath=false) が返す表記と
  // mergeTree() 側の表記が一致することを検証する。フラグを外すと衝突ファイルが
  // 8進エスケープされた別表記になり、branchFiles との積集合が空になって
  // バケットC (ファイルの外) に落ちる。
  it(
    'recognizes a conflict on a non-ASCII path instead of losing it to octal escaping',
    () => {
      const { bare, work } = makeRepo('non-ascii-conflict');
      const nonAsciiPath = 'docs/日本語.md';
      sh(work, 'git', 'checkout', '-qb', 'feature');
      fs.mkdirSync(path.join(work, 'docs'), { recursive: true });
      fs.writeFileSync(path.join(work, nonAsciiPath), 'mine\n');
      sh(work, 'git', 'add', nonAsciiPath);
      sh(work, 'git', 'commit', '-qm', 'mine adds a non-ASCII path');

      const peer = path.join(tmpRoot, 'non-ascii-conflict-peer');
      sh(tmpRoot, 'git', 'clone', '-q', bare, peer);
      sh(peer, 'git', 'checkout', '-qb', 'peer');
      fs.mkdirSync(path.join(peer, 'docs'), { recursive: true });
      fs.writeFileSync(path.join(peer, nonAsciiPath), 'peer\n');
      sh(peer, 'git', 'add', nonAsciiPath);
      sh(peer, 'git', 'commit', '-qm', 'peer adds the same non-ASCII path');
      sh(peer, 'git', 'push', '-q', 'origin', 'peer');
      sh(work, 'git', 'fetch', '-q', 'origin', 'peer');

      const { status, stdout } = runDrift(work, {
        status: 0,
        output: JSON.stringify([
          { number: 41, headRefName: 'peer', isCrossRepository: false },
        ]),
      });
      expect(status).toBe(0);
      expect(stdout).toContain('open PR #41 (peer) と衝突します (rebase でテキスト衝突)');
      expect(stdout).toContain(`  ${nonAsciiPath}`);
      // quotepath=false が外れると、この行に落ちてしまう。
      expect(stdout).not.toContain('衝突パスはこのブランチが触ったファイルの外です');
    },
    15000,
  );

  it(
    'reports a rename conflict even when merge-tree names only the new path',
    () => {
      const { bare, work } = makeRepo('peer-rename-conflict');
      sh(work, 'git', 'checkout', '-qb', 'feature');
      fs.writeFileSync(path.join(work, 'hot.ts'), BIG_FILE('mine'));
      sh(work, 'git', 'commit', '-qam', 'mine');

      const peer = path.join(tmpRoot, 'peer-rename-conflict-peer');
      sh(tmpRoot, 'git', 'clone', '-q', bare, peer);
      sh(peer, 'git', 'checkout', '-qb', 'peer');
      sh(peer, 'git', 'mv', 'hot.ts', 'renamed-hot.ts');
      fs.writeFileSync(path.join(peer, 'renamed-hot.ts'), BIG_FILE('peer'));
      sh(peer, 'git', 'commit', '-qam', 'rename and edit');
      sh(peer, 'git', 'push', '-q', 'origin', 'peer');
      sh(work, 'git', 'fetch', '-q', 'origin', 'peer');

      const { status, stdout } = runDrift(work, {
        status: 0,
        output: JSON.stringify([
          { number: 23, headRefName: 'peer', isCrossRepository: false },
        ]),
      });
      expect(status).toBe(0);
      expect(stdout).toContain('open PR #23 (peer) は衝突していますが');
      expect(stdout).toContain(renameConflictExplanation);
      expect(stdout).not.toContain(staleMainConflictExplanation);
      expect(stdout).toContain('  renamed-hot.ts');
      expect(stdout).toContain('この PR と同じファイルも触っています');
      expect(stdout).toContain('  hot.ts');
      expect(stdout).not.toContain('衝突はしませんが');
    },
    15000,
  );

  it(
    'does not promote a peer branch’s stale-main conflict outside this branch to a direct conflict',
    () => {
      const { bare, work } = makeRepo('peer-stale-main-conflict');

      // peer は base の hot.ts を変える。後で main も同じ行を変えるため、peer を
      // main に rebase すれば解消すべき衝突だけが merge-tree に現れる。
      const peer = path.join(tmpRoot, 'peer-stale-main-conflict-peer');
      sh(tmpRoot, 'git', 'clone', '-q', bare, peer);
      sh(peer, 'git', 'checkout', '-qb', 'peer');
      fs.writeFileSync(path.join(peer, 'hot.ts'), BIG_FILE('peer'));
      sh(peer, 'git', 'commit', '-qam', 'peer');
      sh(peer, 'git', 'push', '-q', 'origin', 'peer');

      advanceMain(bare, 'peer-stale-main-conflict-main', (dir) => {
        fs.writeFileSync(path.join(dir, 'hot.ts'), BIG_FILE('main'));
      });
      sh(work, 'git', 'fetch', '-q', 'origin');
      sh(work, 'git', 'checkout', '-qb', 'feature', 'origin/main');
      fs.writeFileSync(path.join(work, 'mine.ts'), 'mine\n');
      sh(work, 'git', 'add', 'mine.ts');
      sh(work, 'git', 'commit', '-qm', 'mine');

      const { status, stdout } = runDrift(work, {
        status: 0,
        output: JSON.stringify([
          { number: 13, headRefName: 'peer', isCrossRepository: false },
        ]),
      });
      expect(status).toBe(0);
      expect(stdout).not.toContain('HEAD が merge-base そのものです');
      expect(stdout).toContain('衝突パスはこのブランチが触ったファイルの外です');
      expect(stdout).toContain(staleMainConflictExplanation);
      expect(stdout).not.toContain(renameConflictExplanation);
      expect(stdout).not.toContain('open PR #13 (peer) と衝突します');
      expect(stdout).not.toContain('open PR #13 (peer) と同じファイルを触っています');
      expect(stdout).toContain('  hot.ts');
    },
    15000,
  );

  // bdboard-b0yd R2-2: 実測 (`/tmp` の使い捨てリポジトリ) — 自然な
  // merge-tree(HEAD, peer) は exit 1 (CONFLICT) だが、`--merge-base=origin/main`
  // を明示した ground truth は exit 0 (clean)。peer が origin/main に対して
  // stale (自分の hot 行の編集を main の編集と衝突させたまま) なせいで、
  // 「main と peer の衝突」が「自分と peer の衝突」に化けている。衝突ファイルが
  // 自分の branchFiles とファイル名だけで一致しても、この場合は断定してはならない。
  it(
    'softens a layer-1 conflict instead of asserting it when the peer is stale relative to main',
    () => {
      const bare = path.join(tmpRoot, 'stale-layer1.git');
      const work = path.join(tmpRoot, 'stale-layer1');
      fs.mkdirSync(bare, { recursive: true });
      sh(tmpRoot, 'git', 'init', '--bare', '-b', 'main', bare);
      sh(tmpRoot, 'git', 'clone', '-q', bare, work);
      fs.mkdirSync(path.join(work, 'scripts'), { recursive: true });
      fs.copyFileSync(SCRIPT_PATH, path.join(work, 'scripts', 'check-drift.mjs'));
      fs.writeFileSync(path.join(work, 'hot.ts'), HOT_LINE_FILE('base', 'base'));
      sh(work, 'git', 'add', '-A');
      sh(work, 'git', 'commit', '-qm', 'base');
      sh(work, 'git', 'push', '-q', 'origin', 'main');

      // peer は base から分岐し、hot 行だけを編集する。main の後続の編集は
      // 一切取り込まない (= 今後 stale になる)。
      const peer = path.join(tmpRoot, 'stale-layer1-peer');
      sh(tmpRoot, 'git', 'clone', '-q', bare, peer);
      sh(peer, 'git', 'checkout', '-qb', 'peer');
      fs.writeFileSync(path.join(peer, 'hot.ts'), HOT_LINE_FILE('peer', 'base'));
      sh(peer, 'git', 'commit', '-qam', 'peer edits the hot line');
      sh(peer, 'git', 'push', '-q', 'origin', 'peer');

      // main は同じ hot 行を別の値に進める。peer は一度もこれを取り込まない。
      advanceMain(bare, 'stale-layer1-main-advance', (dir) => {
        fs.writeFileSync(path.join(dir, 'hot.ts'), HOT_LINE_FILE('main', 'base'));
      });

      // 自分のブランチは最新の main から分岐し、hot 行とは無関係な marker 行
      // だけを編集する。hot.ts が branchFiles に載るのはこの marker 編集のため。
      sh(work, 'git', 'fetch', '-q', 'origin');
      sh(work, 'git', 'checkout', '-qb', 'feature', 'origin/main');
      fs.writeFileSync(path.join(work, 'hot.ts'), HOT_LINE_FILE('main', 'mine'));
      sh(work, 'git', 'commit', '-qam', 'mine edits an unrelated line');

      const { status, stdout } = runDrift(work, {
        status: 0,
        output: JSON.stringify([
          { number: 40, headRefName: 'peer', isCrossRepository: false },
        ]),
      });

      expect(status).toBe(0);
      // 実際の衝突原因は main vs peer (hot 行) であって、自分の編集 (marker 行)
      // とは無関係。「衝突します」と断定するのは誤りで、弱い文言に落ちる。
      expect(stdout).not.toContain('open PR #40 (peer) と衝突します (rebase でテキスト衝突)');
      expect(stdout).toContain('open PR #40 (peer) と衝突する可能性があります');
      expect(stdout).toContain('peer が origin/main に対して古いため');
      expect(stdout).toContain('  hot.ts');
    },
    15000,
  );

  // bdboard-b0yd R4-A: 象限は4つある (自分/peer それぞれ current か stale か)。
  // `certain` が `weCurrent && peerCurrent` の論理積なのに、else 側の文言は
  // 「peer が古い」としか言わなかった。ここは自分 (feature) が stale、peer が
  // current の象限 (!W && P) — ground truth は clean (`git merge-tree
  // --merge-base=origin/main HEAD origin/peer` は exit 0) なのに、修正前は
  // 「peer が origin/main に対して古いため」と無実の peer を犯人扱いしていた。
  it(
    'blames itself, not a current peer, for a layer-1 conflict caused by its own stale base (A: !W && P)',
    () => {
      const bare = path.join(tmpRoot, 'self-stale-layer1.git');
      const work = path.join(tmpRoot, 'self-stale-layer1');
      fs.mkdirSync(bare, { recursive: true });
      sh(tmpRoot, 'git', 'init', '--bare', '-b', 'main', bare);
      sh(tmpRoot, 'git', 'clone', '-q', bare, work);
      fs.mkdirSync(path.join(work, 'scripts'), { recursive: true });
      fs.copyFileSync(SCRIPT_PATH, path.join(work, 'scripts', 'check-drift.mjs'));
      fs.writeFileSync(path.join(work, 'hot.ts'), HOT_LINE_FILE('base', 'base'));
      sh(work, 'git', 'add', '-A');
      sh(work, 'git', 'commit', '-qm', 'base');
      sh(work, 'git', 'push', '-q', 'origin', 'main');

      // 自分 (feature) は古い base から分岐し、hot 行を編集する。main の
      // その後の進みは一切取り込まない (= 自分が stale になる)。
      sh(work, 'git', 'checkout', '-qb', 'feature');
      fs.writeFileSync(path.join(work, 'hot.ts'), HOT_LINE_FILE('mine', 'base'));
      sh(work, 'git', 'commit', '-qam', 'mine edits the hot line');

      // main は同じ hot 行を別の値に進める。
      advanceMain(bare, 'self-stale-layer1-main-advance', (dir) => {
        fs.writeFileSync(path.join(dir, 'hot.ts'), HOT_LINE_FILE('main', 'base'));
      });

      // peer は advance 後の origin/main から分岐し、hot 行とは無関係な marker
      // 行だけを編集する (peer 自身は origin/main に対して current)。
      const peer = path.join(tmpRoot, 'self-stale-layer1-peer');
      sh(tmpRoot, 'git', 'clone', '-q', bare, peer);
      sh(peer, 'git', 'checkout', '-qb', 'peer');
      fs.writeFileSync(path.join(peer, 'hot.ts'), HOT_LINE_FILE('main', 'peer'));
      sh(peer, 'git', 'commit', '-qam', 'peer edits an unrelated marker line');
      sh(peer, 'git', 'push', '-q', 'origin', 'peer');

      // work には main の advance と peer ブランチだけ取り込む。feature 自体は
      // rebase しない (stale のまま)。
      sh(work, 'git', 'fetch', '-q', 'origin', 'main');
      sh(work, 'git', 'fetch', '-q', 'origin', 'peer');

      const { status, stdout } = runDrift(work, {
        status: 0,
        output: JSON.stringify([
          { number: 50, headRefName: 'peer', isCrossRepository: false },
        ]),
      });

      expect(status).toBe(0);
      expect(stdout).toContain('open PR #50 (peer) と衝突する可能性があります');
      expect(stdout).toContain(layer1SelfStaleExplanation);
      expect(stdout).not.toContain('peer が origin/main に対して古いため');
      expect(stdout).not.toContain('open PR #50 (peer) と衝突します (rebase でテキスト衝突)');
      expect(stdout).toContain('  hot.ts');
    },
    15000,
  );

  // bdboard-b0yd R4-B: バケットC の「原因は一意に決まる」は自分が origin/main
  // に対して current なときしか成立しない。ここは自分が stale なまま
  // origin/main 側の rename (a.ts→b.ts 相当) を編集前の旧パスで触ってしまい、
  // peer は rename 後の main を継承しただけ (peer 自身は何も rename していない)
  // という象限 (!W)。修正前はここで peer を rename 犯人扱いしていた。
  it(
    'does not blame the peer for a rename that originated on origin/main when this branch is the stale one (B: !W)',
    () => {
      const { bare, work } = makeRepo('self-stale-rename');
      // 自分 (feature) は stale (base のまま) で旧パス hot.ts を編集する。
      sh(work, 'git', 'checkout', '-qb', 'feature');
      fs.writeFileSync(path.join(work, 'hot.ts'), BIG_FILE('mine'));
      sh(work, 'git', 'commit', '-qam', 'mine edits the old path');

      // main が hot.ts → renamed-hot.ts に rename して編集する。
      advanceMain(bare, 'self-stale-rename-main', (dir, run) => {
        run('git', 'mv', 'hot.ts', 'renamed-hot.ts');
        fs.writeFileSync(path.join(dir, 'renamed-hot.ts'), BIG_FILE('main'));
      });

      // peer は rename 後の新しい main から分岐し、無関係なファイルだけを
      // 触る (peer 自身は origin/main に対して current で、rename もしていない)。
      const peer = path.join(tmpRoot, 'self-stale-rename-peer');
      sh(tmpRoot, 'git', 'clone', '-q', bare, peer);
      sh(peer, 'git', 'checkout', '-qb', 'peer');
      fs.writeFileSync(path.join(peer, 'unrelated.ts'), 'peer\n');
      sh(peer, 'git', 'add', 'unrelated.ts');
      sh(peer, 'git', 'commit', '-qm', 'peer touches an unrelated file');
      sh(peer, 'git', 'push', '-q', 'origin', 'peer');

      // work には main の advance (rename) と peer ブランチだけ取り込む。
      // feature 自体は rebase しない (stale のまま)。
      sh(work, 'git', 'fetch', '-q', 'origin', 'main');
      sh(work, 'git', 'fetch', '-q', 'origin', 'peer');

      const { status, stdout } = runDrift(work, {
        status: 0,
        output: JSON.stringify([
          { number: 60, headRefName: 'peer', isCrossRepository: false },
        ]),
      });

      expect(status).toBe(0);
      expect(stdout).toContain('衝突パスはこのブランチが触ったファイルの外です');
      expect(stdout).toContain(bucketCSelfStaleExplanation);
      expect(stdout).not.toContain(renameConflictExplanation);
      expect(stdout).not.toContain(staleMainConflictExplanation);
    },
    15000,
  );

  // bdboard-b0yd R4-C: merge-tree が使えない (古い git の未知オプション等) とき、
  // 判定していないのに「衝突はしませんが意味的な整合は要確認」と断定していた。
  // レビューの再現手順どおり、`merge-tree --name-only` だけを失敗させる偽の
  // `git` を PATH の先頭に置いて再現する (check-drift.mjs 自身の `git()` には
  // gh のような差し替えフックが無いため)。
  // bdboard-b0yd R4-C: **Windows では skip する。** この2本は「PATH の先頭に偽の
  // `git` を置いて merge-tree だけ失敗させる」構成だが、check-drift.mjs の `git()` は
  // `execFileSync('git', …)` (shell 無し) なので、Windows では CreateProcess が
  // `git.cmd` を解決せず PATH の後方にある本物の `git.exe` が走る — R2-1 で
  // `gh` について学んだのと同じ罠で、実際に verify-windows がこの2本だけで落ちた
  // (2026-09-06、run 33976779917: シムを素通りして「衝突します」と本物の判定が出た)。
  // ここで検証しているのは **merge-tree が失敗したときの文言の出し分け**であって
  // パス解決ではなく、その分岐に OS 依存は無い。`gh` と同じ env 間接呼び出しフックを
  // `git` にも production 側に増やす手はあるが、この2本のためだけに全 `git()` 呼び出しに
  // 差し替え口を開けるのは割に合わない (この PR は既に凝ったテスト基盤で
  // Windows CI を2度壊している)。verify (Linux) 側で常時実行されるので網は残る。
  const itUnlessWindows = process.platform === 'win32' ? it.skip : it;

  itUnlessWindows(
    'does not assert a clean merge when merge-tree itself is unavailable (C)',
    () => {
      const { bare, work } = makeRepo('mergetree-unavailable');
      sh(work, 'git', 'checkout', '-qb', 'feature');
      fs.writeFileSync(path.join(work, 'hot.ts'), BIG_FILE('mine'));
      sh(work, 'git', 'commit', '-qam', 'mine');

      const peer = path.join(tmpRoot, 'mergetree-unavailable-peer');
      sh(tmpRoot, 'git', 'clone', '-q', bare, peer);
      sh(peer, 'git', 'checkout', '-qb', 'peer');
      fs.writeFileSync(path.join(peer, 'hot.ts'), BIG_FILE('peer'));
      sh(peer, 'git', 'commit', '-qam', 'peer');
      sh(peer, 'git', 'push', '-q', 'origin', 'peer');
      sh(work, 'git', 'fetch', '-q', 'origin', 'peer');

      // 偽の `git`: `merge-tree ... --name-only` だけ未知オプションとして
      // 失敗させ (exit 129, exit 1 の「衝突あり」と区別する)、それ以外は
      // 本物の git に委譲する。PATH の解決は POSIX ("git") と Windows
      // ("git.cmd") の双方に対応させる (拡張子なしスクリプトは Windows の
      // PATHEXT に載らない — R2-1 と同じ理由)。
      const shimDir = path.join(tmpRoot, 'mergetree-unavailable-shim');
      fs.mkdirSync(shimDir, { recursive: true });
      fs.writeFileSync(
        path.join(shimDir, 'git-shim.mjs'),
        [
          "import { spawnSync } from 'node:child_process';",
          'const args = process.argv.slice(2);',
          "const isMergeTreeNameOnly = args.includes('merge-tree') && args.includes('--name-only');",
          'if (isMergeTreeNameOnly) {',
          '  process.stderr.write("fatal: unknown option `--name-only\' (test shim)\\n");',
          '  process.exitCode = 129;',
          '} else {',
          '  const result = spawnSync(process.env.BDBOARD_TEST_REAL_GIT, args, { stdio: "inherit" });',
          '  process.exitCode = result.status === null ? 1 : result.status;',
          '}',
          '',
        ].join('\n'),
      );
      fs.writeFileSync(
        path.join(shimDir, 'git'),
        ['#!/bin/sh', 'DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)', 'exec node "$DIR/git-shim.mjs" "$@"', ''].join(
          '\n',
        ),
      );
      fs.chmodSync(path.join(shimDir, 'git'), 0o755);
      fs.writeFileSync(
        path.join(shimDir, 'git.cmd'),
        ['@echo off', 'node "%~dp0git-shim.mjs" %*', 'exit /b %errorlevel%', ''].join('\r\n'),
      );

      const { status, stdout } = runDrift(
        work,
        {
          status: 0,
          output: JSON.stringify([
            { number: 71, headRefName: 'peer', isCrossRepository: false },
          ]),
        },
        {
          extraEnv: {
            PATH: `${shimDir}${path.delimiter}${process.env.PATH}`,
            BDBOARD_TEST_REAL_GIT: REAL_GIT,
          },
        },
      );

      expect(status).toBe(0);
      // 判定していないのに「衝突しない」と断定してはいけない。
      expect(stdout).not.toContain('衝突はしませんが');
      // merge-tree が使えなかった旨は残る。
      expect(stdout).toContain('merge-tree が使えないため PR #71 (peer) はファイル単位でのみ比較しました');
      // このケースでは唯一の peer が comparedCount から外れ、0件に落ちる。
      expect(stdout).toContain('比較できた open PR がありません');
    },
    15000,
  );

  // bdboard-b0yd R4-C(2): 上の R4-C は peer が1本しかないため comparedCount が0に
  // 落ち、階層2の行そのものが印字されない。つまり「テキスト衝突は判定できませんでした」
  // という**文言側**の修正は上のテストでは一度も実行されず、文言を元の
  // 「衝突はしませんが」に戻しても緑のままだった (議長が実測)。
  //
  // これは「到達不能だから構わない」ではない。`unavailable` は peer 単位で起こりうる:
  // `git merge-tree --write-tree --name-only` は git 2.38 から、`--merge-base=` は
  // **2.40** から入った。2.38/2.39 では、`canUseUpstreamBase` が真になる peer
  // (自分も peer も origin/main 取り込み済み) にだけ `--merge-base=` が渡って失敗し、
  // stale な peer は成功する。つまり同一実行の中で unavailable な peer と比較できた
  // peer が混在し、comparedCount > 0 のまま階層2の行が実際に印字される。
  //
  // その版の git を再現するため、シムは `--merge-base=` が付いたときだけ失敗させる。
  itUnlessWindows(
    'does not claim a clean merge for the peer whose merge-tree failed while another peer was compared (C)',
    () => {
      const { bare, work } = makeRepo('mergetree-unavailable-mixed');

      // 1) stale peer: main が進む**前**に分岐して hot.ts を編集する。
      const stalePeer = path.join(tmpRoot, 'mergetree-unavailable-mixed-stale');
      sh(tmpRoot, 'git', 'clone', '-q', bare, stalePeer);
      sh(stalePeer, 'git', 'checkout', '-qb', 'stalepeer');
      fs.writeFileSync(path.join(stalePeer, 'hot.ts'), BIG_FILE('stale-peer'));
      sh(stalePeer, 'git', 'commit', '-qam', 'stale peer');
      sh(stalePeer, 'git', 'push', '-q', 'origin', 'stalepeer');

      // 2) main を hot.ts とは別のファイルで進める (stale peer だけが取り残される)。
      advanceMain(bare, 'mergetree-unavailable-mixed-advance', (dir) => {
        fs.writeFileSync(path.join(dir, 'marker.ts'), BIG_FILE('advanced'));
      });

      // 3) 自分は**新しい** origin/main から分岐する = weAreCurrentWithUpstream。
      sh(work, 'git', 'fetch', '-q', 'origin');
      sh(work, 'git', 'checkout', '-qb', 'feature', 'origin/main');
      fs.writeFileSync(path.join(work, 'hot.ts'), BIG_FILE('mine'));
      sh(work, 'git', 'commit', '-qam', 'mine');

      // 4) fresh peer: 新しい origin/main から分岐 = peerIsCurrentWithUpstream。
      //    この peer にだけ `--merge-base=` が渡る。
      const freshPeer = path.join(tmpRoot, 'mergetree-unavailable-mixed-fresh');
      sh(tmpRoot, 'git', 'clone', '-q', bare, freshPeer);
      sh(freshPeer, 'git', 'checkout', '-qb', 'freshpeer', 'origin/main');
      fs.writeFileSync(path.join(freshPeer, 'hot.ts'), BIG_FILE('fresh-peer'));
      sh(freshPeer, 'git', 'commit', '-qam', 'fresh peer');
      sh(freshPeer, 'git', 'push', '-q', 'origin', 'freshpeer');

      sh(work, 'git', 'fetch', '-q', 'origin');

      // git 2.38/2.39 のシム: `--merge-base=` が付いた merge-tree だけを未知
      // オプションとして落とし、それ以外は本物の git に委譲する。
      const shimDir = path.join(tmpRoot, 'mergetree-unavailable-mixed-shim');
      fs.mkdirSync(shimDir, { recursive: true });
      fs.writeFileSync(
        path.join(shimDir, 'git-shim.mjs'),
        [
          "import { spawnSync } from 'node:child_process';",
          'const args = process.argv.slice(2);',
          "const isOldMergeTree =",
          "  args.includes('merge-tree') && args.some((a) => a.startsWith('--merge-base='));",
          'if (isOldMergeTree) {',
          '  process.stderr.write("fatal: unknown option `merge-base\' (test shim: git 2.39)\\n");',
          '  process.exitCode = 129;',
          '} else {',
          '  const result = spawnSync(process.env.BDBOARD_TEST_REAL_GIT, args, { stdio: "inherit" });',
          '  process.exitCode = result.status === null ? 1 : result.status;',
          '}',
          '',
        ].join('\n'),
      );
      fs.writeFileSync(
        path.join(shimDir, 'git'),
        ['#!/bin/sh', 'DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)', 'exec node "$DIR/git-shim.mjs" "$@"', ''].join(
          '\n',
        ),
      );
      fs.chmodSync(path.join(shimDir, 'git'), 0o755);
      fs.writeFileSync(
        path.join(shimDir, 'git.cmd'),
        ['@echo off', 'node "%~dp0git-shim.mjs" %*', 'exit /b %errorlevel%', ''].join('\r\n'),
      );

      const { status, stdout } = runDrift(
        work,
        {
          status: 0,
          output: JSON.stringify([
            { number: 81, headRefName: 'freshpeer', isCrossRepository: false },
            { number: 82, headRefName: 'stalepeer', isCrossRepository: false },
          ]),
        },
        {
          extraEnv: {
            PATH: `${shimDir}${path.delimiter}${process.env.PATH}`,
            BDBOARD_TEST_REAL_GIT: REAL_GIT,
          },
        },
      );

      expect(status).toBe(0);
      // stale peer は比較できているので、0件に落ちる上の R4-C とは違い
      // 階層2の行が実際に印字される = 文言側の分岐が実行される。
      expect(stdout).not.toContain('比較できた open PR がありません');
      // 判定していない peer に対して「衝突しない」と断定してはいけない。
      expect(stdout).not.toContain('衝突はしませんが');
      expect(stdout).toContain('テキスト衝突は判定できませんでした');
      expect(stdout).toContain('merge-tree が使えないため PR #81 (freshpeer)');
      // 比較できた peer が居るので、階層1の行も同時に出る (これが「混在」の実体)。
      expect(stdout).toContain('open PR #82 (stalepeer) と衝突する可能性があります');
      // comparedCount そのものは、findings があるとき all-clear 行が出ないので
      // この経路では観測できない。件数の除外は上の R4-C (peer 1本 → 0件) が見る。
    },
    15000,
  );


  // bdboard-b0yd R4-D: fetch が劣化 (degradedSuffix) した状態で、全 peer が
  // missing-ref に落ちて comparedCount が0件になっても、「比較できた open PR が
  // ありません。」にだけ degradedSuffix が付いていなかった。
  it(
    'marks the "no comparable PR" line as degraded when fetch failed and every peer falls back to a missing ref (D)',
    () => {
      const { bare, work } = makeRepo('degraded-no-comparable');
      sh(work, 'git', 'checkout', '-qb', 'feature');
      fs.writeFileSync(path.join(work, 'hot.ts'), BIG_FILE('mine'));
      sh(work, 'git', 'commit', '-qam', 'mine');

      // peer は存在するが、work は一度も fetch しない (missing ref のまま)。
      const peer = path.join(tmpRoot, 'degraded-no-comparable-peer');
      sh(tmpRoot, 'git', 'clone', '-q', bare, peer);
      sh(peer, 'git', 'checkout', '-qb', 'peer');
      fs.writeFileSync(path.join(peer, 'hot.ts'), BIG_FILE('peer'));
      sh(peer, 'git', 'commit', '-qam', 'peer');
      sh(peer, 'git', 'push', '-q', 'origin', 'peer');

      // fetch そのものを失敗させる (既存の「peer fetch failure」テストと同じ手法)。
      sh(work, 'git', 'remote', 'set-url', 'origin', path.join(tmpRoot, 'missing.git'));

      const { status, stdout } = runDrift(
        work,
        {
          status: 0,
          output: JSON.stringify([
            { number: 72, headRefName: 'peer', isCrossRepository: false },
          ]),
        },
        { noFetch: false },
      );
      expect(status).toBe(0);
      expect(stdout).toContain('open PR のブランチを fetch できませんでした');
      expect(stdout).toContain('比較できた open PR がありません。 (古い ref で比較)');
    },
    15000,
  );

  it(
    'reports an unrelated peer as a comparison failure rather than a missing ref',
    () => {
      const { bare, work } = makeRepo('unrelated-peer');
      sh(work, 'git', 'checkout', '-qb', 'feature');
      fs.writeFileSync(path.join(work, 'mine.ts'), 'mine\n');
      sh(work, 'git', 'add', 'mine.ts');
      sh(work, 'git', 'commit', '-qm', 'mine');

      const peer = path.join(tmpRoot, 'unrelated-peer-peer');
      sh(tmpRoot, 'git', 'clone', '-q', bare, peer);
      sh(peer, 'git', 'checkout', '--orphan', 'peer');
      fs.rmSync(path.join(peer, 'hot.ts'));
      fs.writeFileSync(path.join(peer, 'orphan.ts'), 'orphan\n');
      sh(peer, 'git', 'add', '-A');
      sh(peer, 'git', 'commit', '-qm', 'orphan peer');
      sh(peer, 'git', 'push', '-q', 'origin', 'peer');
      sh(work, 'git', 'fetch', '-q', 'origin', 'peer');

      const { status, stdout } = runDrift(work, {
        status: 0,
        output: JSON.stringify([
          { number: 24, headRefName: 'peer', isCrossRepository: false },
        ]),
      });
      expect(status).toBe(0);
      expect(stdout).toContain('比較できた open PR がありません');
      expect(stdout).toContain('比較に失敗したため省略しました (PR #24:');
      expect(stdout).not.toContain('リモート追跡ブランチがないため比較を省略しました');
      // bdboard-b0yd R2-5: unrelated histories は merge-tree 自体も
      // (未知オプションと同じ) 非1終了で失敗する。以前はこれが完全に無言だった。
      expect(stdout).toContain('merge-tree が使えないため PR #24 (peer) はファイル単位でのみ比較しました');
      expect(stdout).toContain('unrelated histories');
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

  // bdboard-pqhe: Windows で実測 10108ms かかって既定の5000msを超えた
  // (2026-09-04, PR#257 の verify-windows)。同一ブランチ・同一内容の別 run では
  // pass しており、product ではなくランナー上の実行時間のばらつき。
  // makeRepo + runDrift でサブプロセスから更に git を呼ぶため、Windows の
  // 遅いプロセス生成がそのまま効く。上2件と同じ 15000 に揃える。
  it(
    'exits 2 without a report when the check cannot run at all',
    () => {
      // merge-base が取れない = 調べられていない。0 で返すと、stdout だけ見ている
      // 呼び出し側から「調べて問題なし」と区別が付かない。
      const { work } = makeRepo('orphan');
      sh(work, 'git', 'remote', 'remove', 'origin');

      const { status, stdout } = runDrift(work);
      expect(status).toBe(2);
      expect(stdout).toBe('');
    },
    15000,
  );

  // bdboard-pqhe: この describe 内で唯一 per-test タイムアウトが無いまま残る
  // ケースだったので予防的に付ける (bdboard-8r5b と同じ判断)。git init --bare /
  // clone / commit x2 / push に runDrift を足しており、git 呼び出し回数は
  // 実際に落ちた orphan ケースより多い。
  it(
    'runs even when the repository path contains a space',
    () => {
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
    },
    15000,
  );
});
