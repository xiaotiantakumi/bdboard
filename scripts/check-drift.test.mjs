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
  const outsideBranchConflictExplanation =
    'peer 側の rename によるパス名のずれ（こちらとの衝突）か、peer 自身が\n' +
    'drift:   origin/main に対して古い（こちらとは無関係）可能性があります。実物を確認してください。';

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
    { noFetch = true } = {},
  ) {
    // 実 gh は呼ばない。CLI 配線テストはネットワーク状態に依存させず、gh の成功・
    // 非ゼロ終了・壊れた JSON をこの小さな代役で再現する。
    const bin = path.join(work, 'fake-bin');
    const argsFile = path.join(bin, 'gh-args.txt');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(
      path.join(bin, 'gh'),
      `#!/bin/sh\nprintf '%s\n' "$@" > '${argsFile.replaceAll("'", "'\\\"'\\\"'")}'\nprintf '%s' '${gh.output.replaceAll("'", "'\\\"'\\\"'")}'\nprintf '%s' '${(gh.stderr ?? '').replaceAll("'", "'\\\"'\\\"'")}' >&2\nexit ${gh.status}\n`,
    );
    fs.chmodSync(path.join(bin, 'gh'), 0o755);
    const args = ['scripts/check-drift.mjs'];
    if (noFetch) {
      args.push('--no-fetch');
    }
    const result = spawnSync(process.execPath, args, {
      cwd: work,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });
    const ghArgs = fs.existsSync(argsFile)
      ? fs.readFileSync(argsFile, 'utf8').trimEnd().split('\n')
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
      expect(stdout).toContain(outsideBranchConflictExplanation);
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
      expect(stdout).toContain(outsideBranchConflictExplanation);
      expect(stdout).not.toContain('open PR #13 (peer) と衝突します');
      expect(stdout).not.toContain('open PR #13 (peer) と同じファイルを触っています');
      expect(stdout).toContain('  hot.ts');
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
