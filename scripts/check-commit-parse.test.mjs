import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'check-commit-parse.mjs');
const FIXTURE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const R5WE_FIXTURE = path.join(FIXTURE_DIR, 'commit-r5we-unparsable.txt');
const QS6_FIXTURE = path.join(FIXTURE_DIR, 'commit-6qs6-parsable.txt');

import {
  KNOWN_UNPARSABLE,
  checkCommitMessage,
  findUnparsableCommits,
  formatFindings,
  isChangelogRelevant,
  isValidAllowlistEntry,
  parseCommitsFromGitLog,
} from './check-commit-parse.mjs';

// fixture は行:列を byte 単位で再現する検証対象なので、CRLF に変換されていると
// 桁がずれてアサーションが落ちる。.gitattributes で eol=lf を固定しているが、
// それ以前に CRLF でチェックアウト済みの作業ツリーは再正規化されるまで直らないため、
// 読み込み側でも正規化して git の設定に依存しないようにする (bdboard-84hu)。
function readFixture(filePath) {
  return fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n');
}

// 素の括弧改行だけの短いメッセージ (例: "fix(x): broken body\n\nopen (\nclose)") は
// @conventional-commits/parser が parse 成功するので、最小合成では r5we の再現にならない。
// 実 fixture の 74 行目括弧行またぎを保ったまま件名だけ差し替える。
/** 実 fixture の件名だけ差し替える。本文 (74 行目の括弧行またぎ) は保つので parse は失敗のまま。 */
function unparsableMessageWithSubject(subject) {
  const lines = readFixture(R5WE_FIXTURE).split('\n');
  lines[0] = subject;
  return lines.join('\n');
}

describe('parseCommitsFromGitLog', () => {
  it('strips leading newlines from records after RS separator', () => {
    const raw = 'AAAA\x1fsubject a\n\nbody a\n\x1e\nBBBB\x1fsubject b\n\x1e\n';
    const commits = parseCommitsFromGitLog(raw);
    expect(commits).toHaveLength(2);
    expect(commits[0].sha).toBe('AAAA');
    expect(commits[1].sha).toBe('BBBB');
    expect(commits[0].sha).not.toMatch(/^\s/);
    expect(commits[1].sha).not.toMatch(/^\s/);
  });
});

describe('checkCommitMessage', () => {
  it('flags the r5we fixture at line 74 column 37', () => {
    const message = readFixture(R5WE_FIXTURE);
    const result = checkCommitMessage(message);
    expect(result.ok).toBe(false);
    expect(result.line).toBe(74);
    expect(result.column).toBe(37);
  });

  it('accepts the 6qs6 fixture', () => {
    const message = readFixture(QS6_FIXTURE);
    expect(checkCommitMessage(message)).toEqual({ ok: true });
  });

  it('parses when the r5we line break inside parens is removed', () => {
    const message = readFixture(R5WE_FIXTURE);
    const lines = message.split('\n');
    lines[73] = `${lines[73]}${lines[74]}`;
    lines.splice(74, 1);
    expect(checkCommitMessage(lines.join('\n'))).toEqual({ ok: true });
  });
});

describe('isChangelogRelevant', () => {
  it('treats feat/fix breaking commits as relevant', () => {
    expect(isChangelogRelevant('fix(x): summary')).toBe(true);
    expect(isChangelogRelevant('feat: summary')).toBe(true);
    expect(isChangelogRelevant('feat!: summary')).toBe(true);
  });

  it('ignores non-changelog conventional types and invalid subjects', () => {
    expect(isChangelogRelevant('chore(deps): summary')).toBe(false);
    expect(isChangelogRelevant('docs: summary')).toBe(false);
    expect(isChangelogRelevant('not conventional')).toBe(false);
  });
});

describe('findUnparsableCommits', () => {
  it('classifies failures, warnings, and allowlist exclusions', () => {
    const unparsableFix = {
      sha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      subject: 'fix(x): broken body',
      message: unparsableMessageWithSubject('fix(x): broken body'),
    };
    const unparsableChore = {
      sha: 'cafebabecafebabecafebabecafebabecafebabe',
      subject: 'chore: broken body',
      message: unparsableMessageWithSubject('chore: broken body'),
    };
    const allowlisted = {
      sha: '15651d3fe4e3f99e9caf4d39a805ad6fd1e35a40',
      subject: 'fix(bdboard-r5we): summary',
      message: unparsableMessageWithSubject('fix(bdboard-r5we): summary'),
    };

    // 除外の仕組みそのものを見るテストなので、本番の KNOWN_UNPARSABLE ではなく
    // リテラルを渡す。本番リストの中身に結び付けると、リストを空にした瞬間に
    // 仕組みのテストまで落ちてしまう。
    const result = findUnparsableCommits([unparsableFix, unparsableChore, allowlisted], {
      allowlist: [{ sha: allowlisted.sha, recovery: 'restore the CHANGELOG line' }],
    });

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].sha).toBe(unparsableFix.sha);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].sha).toBe(unparsableChore.sha);
    expect(result.excluded).toHaveLength(1);
    expect(result.excluded[0].sha).toBe(allowlisted.sha);
    expect(result.unused).toHaveLength(0);

    const shortAllowlist = findUnparsableCommits([allowlisted], {
      allowlist: [{ sha: '15651d3', recovery: 'restore the CHANGELOG line' }],
    });
    expect(shortAllowlist.excluded).toHaveLength(1);
    expect(shortAllowlist.failures).toHaveLength(0);
  });

  // bdboard-721p: allowlist は exit 1 を消す唯一の手段なので、手当てを書き残していない
  // エントリでは黙らせない (fail-closed)。ここが緩むと、このガードが検知したい
  // 「CHANGELOG から黙って消える」事象を allowlist 自身が起こす。
  it('refuses to exclude allowlist entries without a recovery note', () => {
    const unparsableFix = {
      sha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      subject: 'fix(x): broken body',
      message: unparsableMessageWithSubject('fix(x): broken body'),
    };

    for (const allowlist of [
      [{ sha: unparsableFix.sha }],
      [{ sha: unparsableFix.sha, recovery: '' }],
      [{ sha: unparsableFix.sha, recovery: '   ' }],
      [unparsableFix.sha], // 旧仕様の文字列エントリ
    ]) {
      const result = findUnparsableCommits([unparsableFix], { allowlist });
      expect(result.excluded).toHaveLength(0);
      expect(result.failures).toHaveLength(1);
    }
  });

  // bdboard-721p: タグを切ると対象コミットは v<last>..HEAD の範囲から外れる。そのとき
  // エントリは死んだ状態で残るので、掃除できることを呼び出し側に伝えられるようにする。
  it('reports allowlist entries that match no commit in range as unused', () => {
    const parsable = {
      sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      subject: 'fix(x): fine',
      message: 'fix(x): fine\n',
    };
    const entry = { sha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', recovery: 'restore it' };

    const result = findUnparsableCommits([parsable], { allowlist: [entry] });

    expect(result.excluded).toHaveLength(0);
    expect(result.unused).toEqual([entry]);
  });

  // bdboard-qhsb: PR でもこのガードを走らせるようにした。検査範囲はそのPRが足す
  // コミットだけだが、ブランチが main を merge で取り込んでいればそこに
  // "Merge X into Y" が普通に混ざる。これが failure に分類されると、CHANGELOG とは
  // 何の関係も無い理由で PR が赤くなる。conventional な type を持たないので
  // CHANGELOG 対象外 = warning 止まり、という前提の上に ci.yml のコメントが
  // 乗っているので、ここで固定しておく。
  it('treats a GitHub merge commit as a warning, never a failure', () => {
    const mergeCommit = {
      sha: '1111111111111111111111111111111111111111',
      subject: 'Merge 2222222 into 3333333',
      message: 'Merge 2222222 into 3333333\n',
    };

    const result = findUnparsableCommits([mergeCommit], { allowlist: [] });

    expect(result.failures).toHaveLength(0);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].sha).toBe(mergeCommit.sha);
  });

  it('keeps every production allowlist entry usable and documented', () => {
    // このガードは「CHANGELOG から黙って消える」ことを検知するためのもので、
    // 除外リストはその検知を無効化する唯一の手段。エントリの追加が必ず意図的な変更
    // (とレビュー) を伴うよう、本番リストの各エントリに sha・subject・ticket・recovery を要求する。
    // recovery が無いエントリは isValidAllowlistEntry に弾かれて除外として働かない (bdboard-721p)。
    for (const entry of KNOWN_UNPARSABLE) {
      expect(isValidAllowlistEntry(entry)).toBe(true);
      expect(entry.sha).toMatch(/^[0-9a-f]{40}$/);
      expect(entry.subject).toBeTruthy();
      expect(entry.ticket).toMatch(/^bdboard-/);
    }
  });

  it('ignores allowlist entries whose sha is shorter than 7 characters', () => {
    const unparsableFix = {
      sha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      subject: 'fix(x): broken body',
      message: unparsableMessageWithSubject('fix(x): broken body'),
    };

    const result = findUnparsableCommits([unparsableFix], {
      allowlist: [
        { sha: '', recovery: 'r' },
        { sha: 'abc', recovery: 'r' },
        { sha: 'dead', recovery: 'r' },
      ],
    });

    expect(result.failures).toHaveLength(1);
    expect(result.excluded).toHaveLength(0);
  });
});

describe('formatFindings', () => {
  it('includes sha, location, offending line text, and end-of-line guidance', () => {
    const message = readFixture(R5WE_FIXTURE);
    const parsed = checkCommitMessage(message);
    const subject = message.split('\n')[0];
    const report = formatFindings(
      {
        failures: [{ sha: '15651d3fe4e3f99e9caf4d39a805ad6fd1e35a40', subject, message, ...parsed }],
        warnings: [],
        excluded: [],
      },
      { range: 'v0.1.1..HEAD', commitCount: 1 },
    );

    expect(report).toContain('15651d3');
    expect(report).toContain('74:37');
    expect(report).toContain(message.split('\n')[73]);
    expect(report).toContain('この行の末尾 (改行) で落ちています');
    expect(report).not.toMatch(/パーサ: 74:37 — unexpected token '\n/);
  });

  it('reports allowlist exclusions even when failures and warnings are empty', () => {
    const entry = {
      sha: '15651d3fe4e3f99e9caf4d39a805ad6fd1e35a40',
      subject: 'fix: x',
      ticket: 'bdboard-r5we',
      recovery: 'CHANGELOG の 0.1.2 に該当行を手で足す\n二行目の手順',
    };
    const report = formatFindings(
      {
        failures: [],
        warnings: [],
        excluded: [{ sha: entry.sha, subject: entry.subject, entry }],
        unused: [],
      },
      { range: 'v0.1.1..HEAD', commitCount: 8 },
    );

    expect(report).toContain('CHANGELOG 対象の解析不能コミットはありません');
    expect(report).toContain('allowlist により 1 件を除外しました (既知の取りこぼし)');
  });

  // bdboard-721p: allowlist は赤を消すだけで、やるべき手当ては消えていない。赤の代わりに
  // このブロックが恒久的なリマインダになるので、毎回の出力に全文が出ることを固定する。
  it('re-prints the recovery steps of every excluded entry on each run', () => {
    const entry = {
      sha: '5d3be460e19479cfe2fb8e06249bb096a6fcbf7f',
      subject: 'feat(x): summary',
      ticket: 'bdboard-ym9r',
      recovery: 'リリースPR の CHANGELOG に 1 行足す\nタグ後は回復できない',
    };
    const report = formatFindings(
      {
        failures: [],
        warnings: [],
        excluded: [{ sha: entry.sha, subject: entry.subject, entry }],
        unused: [],
      },
      { range: 'v0.1.2..HEAD', commitCount: 3 },
    );

    expect(report).toContain('リリース (タグ生成) の前にやること 1 件');
    expect(report).toContain('bdboard-ym9r');
    expect(report).toContain('リリースPR の CHANGELOG に 1 行足す');
    expect(report).toContain('タグ後は回復できない');
  });

  it('flags unused allowlist entries only when asked (default range)', () => {
    const entry = {
      sha: '5d3be460e19479cfe2fb8e06249bb096a6fcbf7f',
      subject: 'feat(x): summary',
      ticket: 'bdboard-ym9r',
      recovery: 'restore it',
    };
    const result = { failures: [], warnings: [], excluded: [], unused: [entry] };

    const withReport = formatFindings(result, {
      range: 'v0.2.0..HEAD',
      commitCount: 2,
      reportUnused: true,
    });
    expect(withReport).toContain('KNOWN_UNPARSABLE から削除してください');
    expect(withReport).toContain('5d3be46');

    // PR の base..head では allowlist のエントリが範囲外なのは当たり前なので出さない。
    const withoutReport = formatFindings(result, { range: 'aaa..bbb', commitCount: 2 });
    expect(withoutReport).not.toContain('KNOWN_UNPARSABLE から削除してください');
  });
});

describe('check-commit-parse CLI', () => {
  let tmpRoot;

  function sh(cwd, ...args) {
    return execFileSync(args[0], args.slice(1), {
      cwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'T',
        GIT_AUTHOR_EMAIL: 't@e',
        GIT_COMMITTER_NAME: 'T',
        GIT_COMMITTER_EMAIL: 't@e',
      },
    });
  }

  function makeRepo(name, { manifestVersion = '0.0.0', tagVersion = manifestVersion } = {}) {
    const bare = path.join(tmpRoot, `${name}.git`);
    const work = path.join(tmpRoot, name);
    fs.mkdirSync(bare, { recursive: true });
    sh(tmpRoot, 'git', 'init', '--bare', '-b', 'main', bare);
    sh(tmpRoot, 'git', 'clone', '-q', bare, work);
    sh(work, 'git', 'config', 'user.name', 'T');
    sh(work, 'git', 'config', 'user.email', 't@e');
    sh(work, 'git', 'config', 'commit.gpgsign', 'false');
    fs.writeFileSync(
      path.join(work, '.release-please-manifest.json'),
      `${JSON.stringify({ '.': manifestVersion })}\n`,
    );
    fs.writeFileSync(path.join(work, 'seed.txt'), 'seed\n');
    sh(work, 'git', 'add', '-A');
    sh(work, 'git', 'commit', '-qm', 'seed');
    sh(work, 'git', 'tag', `v${tagVersion}`);
    sh(work, 'git', 'push', '-q', 'origin', 'main', '--tags');
    return { bare, work };
  }

  function commitFromFixture(work, fixturePath) {
    sh(work, 'git', 'commit', '-F', fixturePath);
  }

  function runCheck(work, args) {
    return spawnSync(process.execPath, [SCRIPT_PATH, '--repo', work, ...args], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
  }

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'commit-parse-cli-'));
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it(
    'exits 1 when an unparsable fix commit is in range',
    () => {
      const { work } = makeRepo('fail');
      fs.writeFileSync(path.join(work, 'change.txt'), 'x\n');
      sh(work, 'git', 'add', 'change.txt');
      commitFromFixture(work, R5WE_FIXTURE);
      const head = sh(work, 'git', 'rev-parse', 'HEAD').trim();
      const result = runCheck(work, ['--range', 'v0.0.0..HEAD']);
      const combined = `${result.stdout}\n${result.stderr}`;
      expect(result.status).toBe(1);
      expect(combined).toContain('74:37');
      expect(combined).toContain(head.slice(0, 7));
    },
    15000,
  );

  it(
    'exits 0 when only parsable commits are in range',
    () => {
      const { work } = makeRepo('ok');
      fs.writeFileSync(path.join(work, 'change.txt'), 'x\n');
      sh(work, 'git', 'add', 'change.txt');
      commitFromFixture(work, QS6_FIXTURE);

      const result = runCheck(work, ['--range', 'v0.0.0..HEAD']);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('CHANGELOG 対象の解析不能コミットはありません');
    },
    15000,
  );

  it(
    'exits 2 when the release tag from manifest does not exist',
    () => {
      const { work } = makeRepo('unavailable', { manifestVersion: '9.9.9', tagVersion: '0.0.0' });
      const result = runCheck(work, []);
      const combined = `${result.stdout}\n${result.stderr}`;
      expect(result.status).toBe(2);
      expect(combined).toMatch(/commit-parse:/);
    },
    15000,
  );
});
