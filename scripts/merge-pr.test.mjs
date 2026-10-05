// bdboard-ulxa.1: scripts/merge-pr (マージ手順 S1 の prepare / gate / finish) のテスト。
// bdboard-ulxa.2: S2 (着地予定ツリーの verify で rebase を省く) の分岐と終了コードも同じ一時リポジトリで押さえる。
//
// 本物の GitHub・bd・main checkout には触れない。一時ディレクトリに bare の origin と、main
// checkout 役のクローン + そこから git worktree add した PR の worktree を作り、git は本物、gh / bd / npm は scripts/merge-pr/fake-tools.mjs
// (状態 JSON を読み書きする代役) で動かす。検証コマンドは偽の `node verify.cjs` で、
// どの SHA を検証したかをログに残す。Windows は統合部分を skip (bash 前提ではないが、
// 運用するのは macOS のエージェントだけで、always-on-server.test.mjs と同じ扱い)。
//
// bdboard-4dqo: 1500 行の max-lines に余裕を作るため分割した。一時リポジトリの harness は
// merge-pr.test-support.mjs、finish 系のテストは merge-pr.finish.test.mjs (describe 名は同じ)。
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_HOT_FILES,
  DEFAULT_LIGHT_BLIND_FILES,
  bodyReferencesIssue,
  decideS2Class,
  evaluateLandedStatus,
  globToRegExp,
  hotCollisions,
  issueNumberFromExternalRef,
  hasApprovedReview,
  isReleasePleasePull,
  mergeCommand,
  parseGitHubSlug,
  parseMergeConfig,
  readMergeTree,
} from './merge-pr.mjs';
import {
  advanceMain,
  auditText,
  base,
  calls,
  commitAll,
  CONTEXT,
  env,
  fakeState,
  git,
  head,
  landSquash,
  mainCheckout,
  peerCommit,
  pidAlive,
  posted,
  PR,
  readFake,
  readState,
  REPO_ROOT,
  registerTempRepoHooks,
  run,
  SCRIPT,
  setup,
  simulateMerge,
  stateFile,
  status,
  TITLE,
  tmp,
  verified,
  waitUntil,
  work,
  writeFake,
} from './merge-pr.test-support.mjs';

describe('merge-pr pure helpers', () => {
  it('bodyReferencesIssue: matches Closes/Fixes/Resolves/Refs #N case-insensitively but not inside code spans or a different number', () => {
    expect(bodyReferencesIssue('Closes: bdboard-4y8q.8\n\nCloses #432', 432)).toBe(true);
    expect(bodyReferencesIssue('closes #432', 432)).toBe(true);
    expect(bodyReferencesIssue('CLOSES #432', 432)).toBe(true); // 大小文字無視 (小文字の正準形だけでなく)
    expect(bodyReferencesIssue('Fixes #432', 432)).toBe(true);
    expect(bodyReferencesIssue('Resolves #432', 432)).toBe(true);
    expect(bodyReferencesIssue('Refs #432', 432)).toBe(true);
    // GitHub が実際に閉じる活用形はすべて受理する (bdboard-4y8q.8 レビュー指摘:
    // "Fixed #432" 等の正しい書き方をこのゲートだけが誤ってブロックしないように)。
    expect(bodyReferencesIssue('Close #432', 432)).toBe(true);
    expect(bodyReferencesIssue('Closed #432', 432)).toBe(true);
    expect(bodyReferencesIssue('Fix #432', 432)).toBe(true);
    expect(bodyReferencesIssue('Fixed #432', 432)).toBe(true);
    expect(bodyReferencesIssue('Resolve #432', 432)).toBe(true);
    expect(bodyReferencesIssue('Resolved #432', 432)).toBe(true);
    expect(bodyReferencesIssue('Closes #999', 432)).toBe(false);
    expect(bodyReferencesIssue('Closes #4321', 432)).toBe(false); // 番号の完全一致 (部分一致で誤検知しない)
    expect(bodyReferencesIssue('no mention here', 432)).toBe(false);
    expect(bodyReferencesIssue('Encloses #432', 432)).toBe(false); // 語境界 (\b) で "closes" の部分一致を弾く
    expect(bodyReferencesIssue('```\nCloses #432\n```', 432)).toBe(false); // コードフェンス内は無視
    expect(bodyReferencesIssue('see `Closes #432` inline', 432)).toBe(false); // インラインコードも無視
  });

  it('issueNumberFromExternalRef: only the gh-<N> short form (case-insensitive); URL form and non-matches are null', () => {
    expect(issueNumberFromExternalRef('gh-432')).toBe(432);
    expect(issueNumberFromExternalRef('GH-432')).toBe(432);
    expect(issueNumberFromExternalRef('https://github.com/xiaotiantakumi/bdboard/issues/432')).toBeNull();
    expect(issueNumberFromExternalRef(null)).toBeNull();
    expect(issueNumberFromExternalRef(undefined)).toBeNull();
    expect(issueNumberFromExternalRef('gh-abc')).toBeNull();
  });

  const lease = 8 * 60_000;
  const now = Date.parse('2026-09-24T12:00:00Z');

  it('review helpers accept only Opus/Fable records and release-please branches', () => {
    expect(hasApprovedReview({ 'bdboard.model.review': 'opus-5' })).toBe(true);
    expect(hasApprovedReview({ 'bdboard.model.review': 'fable-chair-1' })).toBe(true);
    expect(hasApprovedReview({ 'bdboard.model.review': 'composer-2.5' })).toBe(false);
    expect(hasApprovedReview({})).toBe(false);
    expect(isReleasePleasePull({ headRef: 'release-please--branches--main' })).toBe(true);
    expect(isReleasePleasePull({ headRef: 'bd/demo-1' })).toBe(false);
  });

  it('evaluateLandedStatus: success / failure pass through, pending and missing wait until the lease runs out', () => {
    const commit = now - 60_000;
    const judge = (status, commitTimeMs = commit) => evaluateLandedStatus({ status, commitTimeMs, nowMs: now, leaseMs: lease });
    expect(judge({ state: 'success', updatedAt: commit })).toEqual({ verdict: 'success' });
    expect(judge({ state: 'failure', description: 'x', updatedAt: commit }).verdict).toBe('failure');
    expect(judge({ state: 'error', description: 'x', updatedAt: commit }).verdict).toBe('failure');
    expect(judge(null)).toEqual({ verdict: 'wait', remainingMs: lease - 60_000 });
    expect(judge(null, now - lease - 1).verdict).toBe('stale');
    // failure は LEASE を過ぎても自動では解除しない (明示的な修復が要る)。
    expect(judge({ state: 'failure', updatedAt: now - 10 * lease }, now - 10 * lease).verdict).toBe('failure');
    // pending は最後の更新 (自己修復が上書きした pending を含む) から数える。
    const old = now - 3 * lease;
    expect(judge({ state: 'pending', updatedAt: now - 1000 }, old).verdict).toBe('wait');
    expect(judge({ state: 'pending', updatedAt: old }, old).verdict).toBe('stale');
  });

  it('parseMergeConfig: defaults to S0 and rejects bad values', () => {
    const base = { version: 1, verify: 'npm run verify', prFlow: 'pr' };
    const parsed = parseMergeConfig(base);
    expect(parsed).toEqual({
      ok: true,
      config: {
        mode: 'S0',
        leaseMinutes: 8,
        slotWaitMinutes: 10,
        statusContext: CONTEXT,
        hotFiles: DEFAULT_HOT_FILES,
        lightCheck: 'npm run verify -- --light',
        lightBlindFiles: DEFAULT_LIGHT_BLIND_FILES,
        verify: 'npm run verify',
        mainBranch: 'main',
        repo: null,
      },
    });
    expect(parseMergeConfig({ ...base, merge: { mode: 'S1', repo: 'o/r' } }).config).toMatchObject({ mode: 'S1', repo: 'o/r' });
    expect(parseMergeConfig({ ...base, merge: { mode: 'S2' } }).config.mode).toBe('S2');
    expect(parseMergeConfig({ ...base, merge: { mode: 'S3' } }).config.mode).toBe('S3');
    expect(parseMergeConfig({ ...base, merge: { mode: 'S4' } }).ok).toBe(false);
    expect(parseMergeConfig({ ...base, merge: { hotFiles: ['a/**', '{b,c}.json'] } }).config.hotFiles).toEqual(['a/**', '{b,c}.json']);
    expect(parseMergeConfig({ ...base, merge: { hotFiles: [] } }).config.hotFiles).toEqual([]);
    expect(parseMergeConfig({ ...base, merge: { hotFiles: 'package.json' } }).ok).toBe(false);
    expect(parseMergeConfig({ ...base, merge: { hotFiles: ['{a,b'] } }).ok).toBe(false);
    expect(parseMergeConfig({ ...base, merge: { hotFiles: [''] } }).ok).toBe(false);
    expect(parseMergeConfig({ ...base, merge: { leaseMinutes: 0 } }).ok).toBe(false);
    expect(parseMergeConfig({ ...base, merge: { statusContext: 'has space' } }).ok).toBe(false);
    expect(parseMergeConfig({ ...base, merge: { repo: 'no-slash' } }).ok).toBe(false);
    expect(parseMergeConfig({ ...base, merge: [] }).ok).toBe(false);
    expect(parseMergeConfig({ ...base, verify: '' }).ok).toBe(false);
  });

  it("this repo's own contract has a valid merge block (the S0/S1/S2/S3 switch is one line)", () => {
    const contract = JSON.parse(readFileSync(path.join(REPO_ROOT, '.claude', 'bdboard-harness.json'), 'utf8'));
    const parsed = parseMergeConfig(contract);
    expect(parsed.ok).toBe(true);
    expect(['S0', 'S1', 'S2', 'S3']).toContain(parsed.config.mode);
    expect(parsed.config.hotFiles.some((pattern) => globToRegExp(pattern).test('package-lock.json'))).toBe(true);
    expect(parsed.config.statusContext).toBe(CONTEXT);
    expect(contract.merge.leaseMinutes).toBe(8);
  });

  it('parseGitHubSlug handles https / ssh remotes and rejects others', () => {
    expect(parseGitHubSlug('https://github.com/xiaotiantakumi/bdboard.git')).toBe('xiaotiantakumi/bdboard');
    expect(parseGitHubSlug('git@github.com:xiaotiantakumi/bdboard.git\n')).toBe('xiaotiantakumi/bdboard');
    expect(parseGitHubSlug('https://github.com/o/r')).toBe('o/r');
    expect(parseGitHubSlug('/tmp/origin.git')).toBeNull();
  });

  it('mergeCommand prints a single shell-safe line with --match-head-commit and the (#n) subject', () => {
    expect(mergeCommand(12, 'abc123', 'fix(x-1): a b')).toBe(
      "gh pr merge 12 --squash --delete-branch --match-head-commit abc123 --subject 'fix(x-1): a b (#12)'",
    );
    expect(mergeCommand(4, 'b0b', 'fix(z): multi\nline  title\n')).toBe(
      "gh pr merge 4 --squash --delete-branch --match-head-commit b0b --subject 'fix(z): multi line title (#4)'",
    );
    expect(mergeCommand(3, 'f00', "docs(y): it's $HOME `x`")).toBe(
      "gh pr merge 3 --squash --delete-branch --match-head-commit f00 --subject 'docs(y): it'\\''s $HOME `x` (#3)'",
    );
  });

  it('globToRegExp: * stays inside a directory, ** crosses them, {a,b} alternates, and bad braces throw', () => {
    const match = (glob, file) => globToRegExp(glob).test(file);
    expect(match('package*.json', 'package-lock.json')).toBe(true);
    expect(match('package*.json', 'web/package.json')).toBe(false);
    expect(match('.github/workflows/**', '.github/workflows/ci.yml')).toBe(true);
    expect(match('.github/workflows/**', '.github/dependabot.yml')).toBe(false);
    expect(match('**/tsconfig.json', 'tsconfig.json')).toBe(true);
    expect(match('**/tsconfig.json', 'web/tsconfig.json')).toBe(true);
    expect(match('{a,b/c}.txt', 'b/c.txt')).toBe(true);
    expect(match('{a,b/c}.txt', 'axtxt')).toBe(false); // . は文字どおり
    expect(match('file?.md', 'file1.md')).toBe(true);
    expect(() => globToRegExp('{a,b')).toThrow();
    expect(() => globToRegExp('a}')).toThrow();
    expect(() => globToRegExp('{a,{b}}')).toThrow();
    expect(() => globToRegExp('')).toThrow();
  });

  it('hotCollisions: the same hot kind on both sides (not only the same file) collides; one side alone does not', () => {
    expect(hotCollisions(['web/package-lock.json'], ['package.json'], DEFAULT_HOT_FILES)).toEqual([
      { pattern: DEFAULT_HOT_FILES[0], main: ['web/package-lock.json'], mine: ['package.json'] },
    ]);
    expect(hotCollisions(['.github/workflows/ci.yml'], ['src/a.ts'], DEFAULT_HOT_FILES)).toEqual([]);
    expect(hotCollisions(['src/a.ts'], ['tsconfig.json'], DEFAULT_HOT_FILES)).toEqual([]);
    // eslint.config.mjs / file-size-baseline.json は hot ではない (設計 §6 裁定 3)。
    expect(hotCollisions(['eslint.config.mjs', 'scripts/file-size-baseline.json'], ['eslint.config.mjs', 'scripts/file-size-baseline.json'], DEFAULT_HOT_FILES)).toEqual([]);
    expect(hotCollisions(['.claude/skills/bdboard-harness/SKILL.md'], ['harness/packs/bdboard-harness/SKILL.md'], DEFAULT_HOT_FILES)).toHaveLength(1);
    // 検証系: 入れ子の tsconfig・verify スクリプト群・契約 (verify コマンドを持つ) は同じ種類。
    expect(hotCollisions(['test/e2e/tsconfig.json'], ['scripts/verify-slot.mjs'], DEFAULT_HOT_FILES)).toHaveLength(1);
    expect(hotCollisions(['.claude/bdboard-harness.json'], ['web/tsconfig.app.json'], DEFAULT_HOT_FILES)).toHaveLength(1);
    expect(hotCollisions(['scripts/other.mjs'], ['scripts/verify.mjs'], DEFAULT_HOT_FILES)).toEqual([]);
  });

  it('readMergeTree: exit 0 + OID is clean, exit 1 + OID is a conflict with its files, anything else is unavailable', () => {
    const oid = 'a'.repeat(40);
    expect(readMergeTree({ status: 0, stdout: `${oid}\n`, stderr: '' })).toEqual({ status: 'clean', tree: oid });
    expect(readMergeTree({ status: 1, stdout: `${oid}\nsrc/a.ts\n\nAuto-merging src/a.ts\nCONFLICT (content): x\n`, stderr: '' })).toEqual({
      status: 'conflict',
      files: ['src/a.ts'],
    });
    // exit 0 でも OID が読めなければ木を信用しない。exit 128 等は実行できない扱い (呼び出し側は R)。
    expect(readMergeTree({ status: 0, stdout: 'garbage\n', stderr: '' }).status).toBe('unavailable');
    expect(readMergeTree({ status: 128, stdout: '', stderr: 'fatal: refusing to merge unrelated histories\n' })).toEqual({
      status: 'unavailable',
      reason: 'fatal: refusing to merge unrelated histories',
    });
    expect(readMergeTree({ status: 1, stdout: '', stderr: '' }).status).toBe('unavailable');
  });

  it('decideS2Class: R for anything but one merge-base, a clean merge-tree and no hot collision; otherwise F with the tree', () => {
    const tree = 'b'.repeat(40);
    const clean = { status: 'clean', tree };
    expect(decideS2Class({ baseCount: 1, merge: clean, hot: [] })).toEqual({ class: 'F', reason: '衝突なし・hot file なし', tree });
    expect(decideS2Class({ baseCount: 2, merge: clean, hot: [] })).toMatchObject({ class: 'R', reason: expect.stringContaining('criss-cross') });
    expect(decideS2Class({ baseCount: 0, merge: null, hot: [] }).class).toBe('R');
    expect(decideS2Class({ baseCount: 1, merge: { status: 'conflict', files: ['x.ts'] }, hot: [] }).reason).toBe('テキスト衝突: x.ts');
    expect(decideS2Class({ baseCount: 1, merge: { status: 'unavailable', reason: 'boom' }, hot: [] }).class).toBe('R');
    const hot = [{ pattern: 'p', main: ['package-lock.json'], mine: ['package.json'] }];
    expect(decideS2Class({ baseCount: 1, merge: clean, hot })).toEqual({ class: 'R', reason: 'hot file: main package-lock.json / 自分 package.json' });
  });
});

describe('hasApprovedReview spelling variants', () => {
  const has = (value) => hasApprovedReview({ 'bdboard.model.review': value });
  it('accepts supported model spellings and rejects near matches and non-strings', () => {
    for (const value of ['claude-opus-5', 'claude-opus-5-5', 'claude:opus', 'Opus 5.5', 'fable-5.1']) {
      expect(has(value)).toBe(true);
    }
    for (const value of ['opusx-fake', 'fabled-sonnet', 'sonnet-5', 42, null, undefined, [], {}]) {
      expect(has(value)).toBe(false);
    }
    expect(hasApprovedReview({})).toBe(false);
  });
});

// 1 テストで node / git を十数回起こす。verify の並列実行中でも既定 5 秒で落ちないよう余裕を取る。
describe.skipIf(process.platform === 'win32')('merge-pr phases against a temp repo + fake gh/bd/npm', { timeout: 30_000 }, () => {
  registerTempRepoHooks();

  it('rejects usage errors before touching git', () => {
    setup();
    expect(run(['--help']).status).toBe(0);
    expect(run([]).status).toBe(1);
    expect(run(['bogus', '7']).status).toBe(1);
    expect(run(['gate', 'x']).status).toBe(1);
    expect(run(['prepare', '7', '--force']).status).toBe(1);
    expect(readFake().calls).toEqual([]);
  });

  it("prepare: refuses when its own tooling (scripts/merge-pr) is stale vs origin/main", () => {
    setup();
    mkdirSync(path.join(mainCheckout, 'scripts'), { recursive: true });
    writeFileSync(path.join(mainCheckout, 'scripts', 'merge-pr.mjs'), '// pretend main moved this tool\n');
    commitAll(mainCheckout, 'chore: touch merge-pr tool');
    git(mainCheckout, ['push', '-q', 'origin', 'main']);
    const result = run(['prepare', String(PR)]);
    expect(result.status).toBe(3);
    expect(result.stderr).toContain('scripts/merge-pr');
    expect(calls('gh')).toEqual([]);
    expect(calls('bd')).toEqual([]);
  });

  it('prepare: a PR that only changes scripts/merge-pr itself does not trip the staleness check', () => {
    setup({ branchFiles: { 'scripts/merge-pr/whatever.mjs': '// pr-only change\n' } });
    const result = run(['prepare', String(PR)]);
    expect(result.status).not.toBe(3);
    expect(result.stderr).toContain('クラス=N');
    expect(result.stderr).not.toContain('scripts/merge-pr');
  });

  it('prepare: main changing scripts/merge-pr after the branch point still trips the check', () => {
    setup();
    mkdirSync(path.join(mainCheckout, 'scripts', 'merge-pr'), { recursive: true });
    writeFileSync(path.join(mainCheckout, 'scripts', 'merge-pr', 'foo.mjs'), '// main moved this tool\n');
    commitAll(mainCheckout, 'chore: touch merge-pr directory');
    git(mainCheckout, ['push', '-q', 'origin', 'main']);
    const result = run(['prepare', String(PR)]);
    expect(result.status).toBe(3);
    expect(result.stderr).toContain('git merge');
    expect(result.stderr).toContain('取り込んで');
  });

  it('S0: prepare only reports the class and gate / finish refuse to run', () => {
    setup({ merge: { mode: 'S0' } });
    const prepared = run(['prepare', String(PR)]);
    expect(prepared.status).toBe(0);
    expect(prepared.stderr).toContain('クラス=N');
    expect(prepared.stderr).toContain('merge.mode は S0');
    expect(existsSync(stateFile())).toBe(false);
    expect(run(['gate', String(PR)]).status).toBe(2);
    expect(run(['finish', String(PR)]).status).toBe(2);
    expect(calls('bd').filter((c) => c[1] !== 'show')).toEqual([]);
  });

  it('prepare: requires an Opus/Fable review record and a ticket branch, except release-please', () => {
    setup();
    writeFake({ bdShow: { 'demo-1': [{ metadata: {} }] } });
    const missing = run(['prepare', String(PR)]);
    expect(missing.status).toBe(2);
    expect(missing.stderr).toContain('レビュー記録がありません: bd update demo-1 --set-metadata bdboard.model.review=<model>');
    expect(missing.stderr).toContain('現在の値: なし');

    setup();
    writeFake({ bdShow: { 'demo-1': [] } });
    expect(run(['prepare', String(PR)]).stderr).toContain('現在の値: なし');

    setup();
    writeFake({ bdShow: { 'demo-1': [{ metadata: null }] } });
    expect(run(['prepare', String(PR)]).stderr).toContain('現在の値: なし');

    setup();
    writeFake({ bdShow: { 'demo-1': 'not-found' } });
    const notFound = run(['prepare', String(PR)]);
    expect(notFound.status).toBe(2);
    expect(notFound.stderr.trim()).toBe('merge-pr: チケット demo-1 が bd にありません');

    setup();
    writeFake({ bdShow: { 'demo-1': 'unreachable' } });
    const unreachable = run(['prepare', String(PR)]);
    expect(unreachable.status).toBe(1);
    expect(unreachable.stderr).toContain('dolt server unreachable');

    setup();
    writeFake({ bdShow: { 'demo-1': 'bad-json' } });
    expect(run(['prepare', String(PR)]).status).toBe(1);

    setup();
    expect(run(['prepare', String(PR), '--dry-run']).status).toBe(0);
    writeFake({ bdShow: { 'demo-1': [{ metadata: {} }] } });
    expect(run(['prepare', String(PR), '--dry-run']).status).toBe(2);

    setup();
    const child = readFake();
    child.pulls[PR].head.ref = 'bd/demo-1.2';
    child.bdShow['demo-1.2'] = [{ metadata: { 'bdboard.model.review': 'opus-5' } }];
    writeFileSync(fakeState, JSON.stringify(child));
    expect(run(['prepare', String(PR)]).status).toBe(0);
    expect(calls('bd', 'show').some((call) => call.includes('demo-1.2'))).toBe(true);

    setup();
    expect(run(['prepare', String(PR)], { BDBOARD_MERGER: '' }).status).toBe(0);

    setup();
    const fake = readFake();
    fake.pulls[PR].head.ref = 'spike/no-ticket';
    writeFileSync(fakeState, JSON.stringify(fake));
    const noTicket = run(['prepare', String(PR)]);
    expect(noTicket.status).toBe(2);
    expect(noTicket.stderr).toContain('チケット ID がありません');

    setup();
    const release = readFake();
    release.pulls[PR].head.ref = 'release-please--branches--main';
    writeFileSync(fakeState, JSON.stringify(release));
    expect(run(['prepare', String(PR), '--dry-run']).status).toBe(0);
    expect(calls('bd', 'show')).toEqual([]);
    run(['prepare', String(PR)]);
    expect(calls('bd', 'show')).toEqual([]);
  });

  it('gate and finish require BDBOARD_MERGER=chair, including gate --repair', () => {
    setup();
    for (const args of [
      ['gate', String(PR)],
      ['gate', String(PR), '--repair'],
      ['finish', String(PR)],
      ['verify', '0123456789abcdef'],
    ]) {
      const result = run(args, { BDBOARD_MERGER: '' });
      expect(result.status).toBe(7);
      expect(result.stderr).toContain('gate / finish は議長だけが行います。BDBOARD_MERGER=chair を前置してください。');
    }
    expect(run(['gate', String(PR)], { BDBOARD_MERGER: 'Chair' }).status).toBe(7);
    expect(readFake().calls).toEqual([]);
  });

  it('prepare: class R when main moved past the PR base (rebase outside the slot)', () => {
    setup();
    git(work, ['push', '-q', 'origin', `${peerCommit()}:refs/heads/main`]);
    const prepared = run(['prepare', String(PR)]);
    expect(prepared.status).toBe(3);
    expect(prepared.stderr).toContain('クラス=R');
    expect(prepared.stderr).toContain('git rebase origin/main');
    expect(existsSync(stateFile())).toBe(false);
    expect(calls('gh', 'checks')).toEqual([]);
  });

  it('prepare: refuses a HEAD that is not the PR head, pending CI (75) and red CI (2)', () => {
    setup();
    const fake = readFake();
    fake.pulls[PR].head.sha = base;
    writeFileSync(fakeState, JSON.stringify(fake));
    expect(run(['prepare', String(PR)]).status).toBe(2);
    fake.pulls[PR].head.sha = head;
    writeFileSync(fakeState, JSON.stringify(fake));
    writeFake({ checks: { [PR]: 8 } });
    expect(run(['prepare', String(PR)]).status).toBe(75);
    writeFake({ checks: { [PR]: 1 } });
    expect(run(['prepare', String(PR)]).status).toBe(2);
    expect(existsSync(stateFile())).toBe(false);
  });

  function setPullBody(body) {
    const fake = readFake();
    fake.pulls[String(PR)] = { ...fake.pulls[String(PR)], body };
    writeFileSync(fakeState, JSON.stringify(fake));
  }

  it('prepare: a ticket with no external-ref is not gated at all (a null external_ref short-circuits the gate)', () => {
    setup();
    expect(run(['prepare', String(PR)]).status).toBe(0);
    expect(existsSync(stateFile())).toBe(true);
    expect(calls('bd', 'show').length).toBe(1);
  });

  it('prepare: gh-<N> external-ref with "Closes #N" in the PR body succeeds', () => {
    setup();
    writeFake({ bdShow: { 'demo-1': [{ external_ref: 'gh-432', metadata: { 'bdboard.model.review': 'opus-5' } }] } });
    setPullBody('Closes: demo-1\n\nCloses #432\n\nsummary');
    const prepared = run(['prepare', String(PR)]);
    expect(prepared.status).toBe(0);
    expect(existsSync(stateFile())).toBe(true);
    expect(calls('bd', 'show').length).toBe(1);
  });

  it('prepare: gh-<N> external-ref with "Refs #N" (not the last PR for the issue) also succeeds', () => {
    setup();
    writeFake({ bdShow: { 'demo-1': [{ external_ref: 'gh-432', metadata: { 'bdboard.model.review': 'opus-5' } }] } });
    setPullBody('Closes: demo-1\n\nRefs #432\n\nsummary');
    const prepared = run(['prepare', String(PR)]);
    expect(prepared.status).toBe(0);
    expect(existsSync(stateFile())).toBe(true);
    expect(calls('bd', 'show').length).toBe(1);
  });

  it('prepare: gh-<N> external-ref with neither Closes/Fixes/Resolves/Refs #N in the body is blocked (exit 2, same code as other preconditions)', () => {
    setup();
    writeFake({ bdShow: { 'demo-1': [{ external_ref: 'gh-432', metadata: { 'bdboard.model.review': 'opus-5' } }] } });
    setPullBody('Closes: demo-1\n\nsummary with no issue reference');
    const prepared = run(['prepare', String(PR)]);
    expect(prepared.status).toBe(2);
    expect(prepared.stderr).toContain('#432 への言及が PR #7 の本文にありません');
    expect(prepared.stderr).toContain('Closes #432');
    expect(prepared.stderr).toContain('Refs #432');
    expect(existsSync(stateFile())).toBe(false);
  });

  it('prepare: the closing keyword is matched case-insensitively ("CLOSES #N", not just the canonical lowercase form)', () => {
    setup();
    writeFake({ bdShow: { 'demo-1': [{ external_ref: 'gh-432', metadata: { 'bdboard.model.review': 'opus-5' } }] } });
    setPullBody('CLOSES #432');
    expect(run(['prepare', String(PR)]).status).toBe(0);
  });

  it('prepare: GitHub-valid inflected closing keywords ("Fixed #N", "Closed #N") are accepted, not just the present-tense forms', () => {
    setup();
    writeFake({ bdShow: { 'demo-1': [{ external_ref: 'gh-432', metadata: { 'bdboard.model.review': 'opus-5' } }] } });
    setPullBody('Fixed #432');
    expect(run(['prepare', String(PR)]).status).toBe(0);
  });

  it('prepare: a Closes for a different issue number does not satisfy the gate (blocks)', () => {
    setup();
    writeFake({ bdShow: { 'demo-1': [{ external_ref: 'gh-432', metadata: { 'bdboard.model.review': 'opus-5' } }] } });
    setPullBody('Closes #999'); // 別 issue — 432 には言及していない
    const prepared = run(['prepare', String(PR)]);
    expect(prepared.status).toBe(2);
    expect(prepared.stderr).toContain('#432 への言及が PR #7 の本文にありません');
  });

  it('prepare: "Closes #N" inside a fenced code block does not count (avoids a false positive on sample code)', () => {
    setup();
    writeFake({ bdShow: { 'demo-1': [{ external_ref: 'gh-432', metadata: { 'bdboard.model.review': 'opus-5' } }] } });
    setPullBody('```\nCloses #432\n```');
    const prepared = run(['prepare', String(PR)]);
    expect(prepared.status).toBe(2);
    expect(prepared.stderr).toContain('#432 への言及が PR #7 の本文にありません');
    expect(existsSync(stateFile())).toBe(false);
  });

  it('S2 prepare: a missing issue reference blocks class F before the predicted verify (no verify run, no state)', () => {
    setup({ merge: { mode: 'S2' } });
    advanceMain({ 'peer.txt': 'peer\n' });
    writeFake({ bdShow: { 'demo-1': [{ external_ref: 'gh-432', metadata: { 'bdboard.model.review': 'opus-5' } }] } });
    setPullBody('Closes: demo-1');
    const prepared = run(['prepare', String(PR)]);
    expect(prepared.status).toBe(2);
    expect(prepared.stderr).toContain('クラス=F');
    expect(prepared.stderr).toContain('#432 への言及が PR #7 の本文にありません');
    expect(verified()).toEqual([]); // 着地予定ツリーの verify (数分・verify スロット) を走らせる前に止まる
    expect(existsSync(stateFile())).toBe(false);
    expect(git(work, ['symbolic-ref', '--short', 'HEAD'])).toBe('bd/demo-1');
  });

  it('prepare: the external-ref check reuses the review check\'s single bd read (no second bd show)', () => {
    setup();
    writeFake({ bdShow: { 'demo-1': [{ external_ref: 'gh-432', metadata: { 'bdboard.model.review': 'opus-5' } }] } });
    setPullBody('Closes #432');
    expect(run(['prepare', String(PR)]).status).toBe(0);
    expect(calls('bd', 'show')).toHaveLength(1);
  });

  it('happy path: slot is held only from gate to finish, and the landed tree is verified and recorded', () => {
    setup();
    expect(run(['prepare', String(PR)]).status).toBe(0);
    expect(JSON.parse(readFileSync(stateFile(), 'utf8'))).toMatchObject({ pr: PR, id: 'demo-1', head, predBase: base, class: 'N' });

    const gated = run(['gate', String(PR)]);
    expect(gated.stderr).not.toContain('想定外');
    expect(gated.status).toBe(0);
    expect(gated.stdout).toBe(`gh pr merge ${PR} --squash --delete-branch --match-head-commit ${head} --subject '${TITLE} (#${PR})'\n`);
    expect(readFake().slot.holder).toBe(`demo-1 / PR#${PR}`);
    expect(run(['gate', String(PR)]).status).toBe(2); // 二重 gate しない

    const landed = simulateMerge();
    const finished = run(['finish', String(PR)]);
    expect(finished.stderr).toContain('着地後検証 success');
    expect(finished.stderr).toContain('同一');
    expect(finished.status).toBe(0);
    expect(readFake().slot.holder).toBeNull();
    expect(posted().map(({ sha, state, context }) => [sha, state, context])).toEqual([
      [landed, 'pending', CONTEXT],
      [landed, 'success', CONTEXT],
    ]);
    expect(verified()).toEqual([landed]);
    expect(git(work, ['symbolic-ref', '--short', 'HEAD'])).toBe('bd/demo-1');
    expect(existsSync(stateFile())).toBe(false);
    const audit = auditText();
    for (const event of ['\tprepare\t', '\tgate-acquired\t', '\tfinish-released\t', '\tlanded-verify\t']) {
      expect(audit).toContain(event);
    }
    expect(audit).toMatch(/finish-released\tpr=7\tid=demo-1\theld_s=\d+/);
    expect(audit).toMatch(/finish-merged\tpr=7\tid=demo-1\tmerged=true\tnew=[0-9a-f]{40}/);
    expect(run(['finish', String(PR)]).status).toBe(2);
  });

  it('gate: CAS lost after acquire releases the slot and sends the agent back to prepare', () => {
    setup();
    expect(run(['prepare', String(PR)]).status).toBe(0);
    writeFake({ slot: { holder: null, onAcquire: ['git', '-C', work, 'push', '-q', 'origin', `${peerCommit()}:refs/heads/main`] } });
    const gated = run(['gate', String(PR)]);
    expect(gated.status).toBe(75);
    expect(gated.stdout).toBe('');
    expect(gated.stderr).toContain('CAS 負け');
    expect(readFake().slot.holder).toBeNull();
    expect(calls('bd', 'release')).toEqual([['bd', 'merge-slot', 'release', '--holder', `demo-1 / PR#${PR}`]]);
    expect(existsSync(stateFile())).toBe(false);
    expect(auditText()).toContain('\tgate-cas-lost\t');
  });

  it('gate: main moving or the PR head changing after prepare means start over without taking the slot', () => {
    setup();
    expect(run(['prepare', String(PR)]).status).toBe(0);
    git(work, ['push', '-q', 'origin', `${peerCommit()}:refs/heads/main`]);
    expect(run(['gate', String(PR)]).status).toBe(75);
    expect(calls('bd', 'acquire')).toEqual([]);

    setup();
    expect(run(['prepare', String(PR)]).status).toBe(0);
    const fake = readFake();
    fake.pulls[PR].head.sha = base;
    writeFileSync(fakeState, JSON.stringify(fake));
    expect(run(['gate', String(PR)]).status).toBe(75);
    expect(calls('bd', 'acquire')).toEqual([]);
  });

  it('gate: waits while the previous landed-verify is pending within the lease', () => {
    setup();
    writeFake({ statuses: {}, statusQueue: { [base]: [[status('pending')], [status('pending')], [status('success')]] } });
    expect(run(['prepare', String(PR)]).status).toBe(0);
    const gated = run(['gate', String(PR)]);
    expect(gated.status).toBe(0);
    expect(gated.stderr).toContain('着地後検証を待っています');
    expect(calls('gh').filter((call) => call.some((arg) => arg.endsWith(`/commits/${base}/status`))).length).toBe(3);
    expect(verified()).toEqual([]);
  });

  it('gate: a failed landed-verify on main blocks the merge without taking the slot', () => {
    setup();
    writeFake({ statuses: { [base]: [status('failure')] } });
    expect(run(['prepare', String(PR)]).status).toBe(0);
    const gated = run(['gate', String(PR)]);
    expect(gated.status).toBe(4);
    expect(gated.stderr).toContain('bd create --type bug -p 0');
    expect(calls('bd', 'acquire')).toEqual([]);
    expect(existsSync(stateFile())).toBe(false);
  });

  it.each([
    ['no status at all', []],
    ['a pending status nobody finished', [status('pending', '2026-01-01T00:00:00Z')]],
  ])('gate: self-heals when the lease has run out (%s)', (_label, statuses) => {
    setup({ mainDate: '2026-01-01T00:00:00Z' });
    writeFake({ statuses: { [base]: statuses } });
    expect(run(['prepare', String(PR)]).status).toBe(0);
    const gated = run(['gate', String(PR)]);
    expect(gated.stderr).toContain('自己修復');
    expect(gated.status).toBe(0);
    expect(posted().map(({ sha, state }) => [sha, state])).toEqual([
      [base, 'pending'],
      [base, 'success'],
    ]);
    expect(verified()).toEqual([base]);
    expect(git(work, ['symbolic-ref', '--short', 'HEAD'])).toBe('bd/demo-1');
    expect(auditText()).toContain('\tgate-self-heal\t');
  });

  it('gate: a failing self-heal records failure and blocks the merge', () => {
    setup({ mainDate: '2026-01-01T00:00:00Z' });
    writeFake({ statuses: {} });
    expect(run(['prepare', String(PR)]).status).toBe(0);
    const gated = run(['gate', String(PR)], { FAKE_VERIFY_EXIT: '1' });
    expect(gated.status).toBe(4);
    expect(posted().map(({ state }) => state)).toEqual(['pending', 'failure']);
    expect(calls('bd', 'acquire')).toEqual([]);
    expect(git(work, ['symbolic-ref', '--short', 'HEAD'])).toBe('bd/demo-1');
  });

  it("gate: waits for someone else's slot, never releases it, and gives up after slotWaitMinutes", () => {
    setup();
    writeFake({ slot: { holder: 'other-1 / PR#1', freeAfter: 2 } });
    expect(run(['prepare', String(PR)]).status).toBe(0);
    expect(run(['gate', String(PR)]).status).toBe(0);
    expect(calls('bd', 'acquire').length).toBe(3);
    expect(calls('bd', 'release')).toEqual([]);

    setup({ merge: { slotWaitMinutes: 0.003 } });
    writeFake({ slot: { holder: 'other-1 / PR#1' } });
    expect(run(['prepare', String(PR)]).status).toBe(0);
    const gated = run(['gate', String(PR)]);
    expect(gated.status).toBe(75);
    expect(gated.stderr).toContain('他人の枠は release しません');
    expect(calls('bd', 'release')).toEqual([]);
    expect(readFake().slot.holder).toBe('other-1 / PR#1');
    expect(auditText()).toContain('\tgate-slot-timeout\t');
  });

  it('gate: takes over a slot this same PR already holds (an interrupted earlier gate)', () => {
    setup();
    writeFake({ slot: { holder: `demo-1 / PR#${PR}` } });
    expect(run(['prepare', String(PR)]).status).toBe(0);
    expect(run(['gate', String(PR)]).status).toBe(0);
    expect(calls('bd', 'acquire')).toEqual([]);
  });

  it('npm ci runs only when the lockfile differs from what the worktree last installed', () => {
    setup({ mainDate: '2026-01-01T00:00:00Z', branchFiles: { 'package-lock.json': '{"lockfileVersion":3}\n' } });
    writeFake({ statuses: {} });
    expect(run(['prepare', String(PR)]).status).toBe(0);
    // 自己修復: 入っているのはブランチの lockfile、検証するのは lockfile の無い main → npm ci
    expect(run(['gate', String(PR)]).status).toBe(0);
    expect(calls('npm')).toEqual([['npm', 'ci']]);
    simulateMerge();
    // finish: 入っているのは main の依存、着地した木はブランチの lockfile → もう一度 npm ci
    expect(run(['finish', String(PR)]).status).toBe(0);
    expect(calls('npm')).toEqual([['npm', 'ci'], ['npm', 'ci']]);
  });

  it('gate --repair: the fix PR for a broken main takes over the main-broken slot and returns it only after success', () => {
    setup();
    const brokenHolder = `demo-0 / main-broken ${base.slice(0, 12)}`;
    writeFake({ statuses: { [base]: [status('failure')] }, slot: { holder: brokenHolder } });
    expect(run(['prepare', String(PR)]).status).toBe(0);
    expect(run(['gate', String(PR)]).status).toBe(4);
    expect(run(['prepare', String(PR)]).status).toBe(0);
    const gated = run(['gate', String(PR), '--repair']);
    expect(gated.status).toBe(0);
    expect(gated.stdout).toBe(`gh pr merge ${PR} --squash --delete-branch --match-head-commit ${head} --subject '${TITLE} (#${PR})'\n`);
    expect(calls('bd', 'acquire')).toEqual([]);
    expect(readFake().slot.holder).toBe(brokenHolder);
    const landed = simulateMerge();
    const finished = run(['finish', String(PR)]);
    expect(finished.status).toBe(0);
    expect(finished.stderr).toContain('main が緑に戻った');
    expect(readFake().slot.holder).toBeNull();
    expect(calls('bd', 'release')).toEqual([['bd', 'merge-slot', 'release', '--holder', brokenHolder]]);
    expect(posted().map(({ sha, state }) => [sha, state])).toEqual([
      [landed, 'pending'],
      [landed, 'success'],
    ]);
    expect(auditText()).toContain('\trepair-released\t');
  });

  it('gate --repair: a refused or still-failing repair keeps holding the main-broken slot', () => {
    setup();
    writeFake({ statuses: { [base]: [status('failure')] } });
    expect(run(['prepare', String(PR)]).status).toBe(0);
    expect(run(['gate', String(PR), '--repair']).status).toBe(0);
    const holder = `demo-1 / main-broken ${base.slice(0, 12)}`;
    expect(readFake().slot.holder).toBe(holder);
    const refused = run(['finish', String(PR)]);
    expect(refused.status).toBe(5);
    expect(refused.stderr).toContain('保持しています');
    expect(readFake().slot.holder).toBe(holder);
    expect(run(['prepare', String(PR)]).status).toBe(0);
    expect(run(['gate', String(PR), '--repair']).status).toBe(0);
    simulateMerge();
    expect(run(['finish', String(PR)], { FAKE_VERIFY_EXIT: '1' }).status).toBe(6);
    expect(readFake().slot.holder).toBe(holder);
    expect(calls('bd', 'release')).toEqual([]);
  });

  it('gate: a broken bd fails fast instead of waiting out slotWaitMinutes', () => {
    setup();
    expect(run(['prepare', String(PR)]).status).toBe(0);
    writeFake({ slot: { holder: null, broken: true } });
    const gated = run(['gate', String(PR)]);
    expect(gated.status).toBe(1);
    expect(gated.stderr).toContain('bd merge-slot を使えません');
    expect(gated.stdout).toBe('');
    expect(calls('bd', 'acquire')).toEqual([]);
  });

  it('prepare: a GitHub API error from gh pr checks is a retry (75), not red CI', () => {
    setup();
    writeFake({ checksError: { [PR]: 'GraphQL: API rate limit exceeded for user ID 1.' } });
    const prepared = run(['prepare', String(PR)]);
    expect(prepared.status).toBe(75);
    expect(prepared.stderr).toContain('取得できませんでした');
    expect(existsSync(stateFile())).toBe(false);
  });

  it('gate: an unreadable remote after acquire returns the slot and is not reported as a CAS loss', () => {
    setup();
    expect(run(['prepare', String(PR)]).status).toBe(0);
    writeFake({ slot: { holder: null, onAcquire: ['git', '-C', work, 'remote', 'set-url', 'origin', path.join(tmp, 'gone.git')] } });
    const gated = run(['gate', String(PR)]);
    expect(gated.status).toBe(75);
    expect(gated.stderr).toContain('ls-remote');
    expect(gated.stderr).not.toContain('CAS 負け');
    expect(gated.stdout).toBe('');
    expect(readFake().slot.holder).toBeNull();
  });

  it('self-heal: a failing npm ci is an error (exit 1) and writes nothing to the ledger', () => {
    setup({ mainDate: '2026-01-01T00:00:00Z', branchFiles: { 'package-lock.json': '{"lockfileVersion":3}\n' } });
    writeFake({ statuses: {}, npmExit: 1 });
    expect(run(['prepare', String(PR)]).status).toBe(0);
    const gated = run(['gate', String(PR)]);
    expect(gated.status).toBe(1);
    expect(gated.stderr).toContain('台帳には書きません');
    expect(posted()).toEqual([]);
    expect(calls('bd', 'acquire')).toEqual([]);
    expect(git(work, ['symbolic-ref', '--short', 'HEAD'])).toBe('bd/demo-1');
  });

  // ---- bdboard-ulxa.2: S2 (着地予定ツリーを手元で verify して rebase を省く) ----

  it('S2 prepare: main not moved is class N exactly as in S1 (no predicted verify)', () => {
    setup({ merge: { mode: 'S2' } });
    const prepared = run(['prepare', String(PR)]);
    expect(prepared.status).toBe(0);
    expect(prepared.stderr).toContain('クラス=N');
    expect(readState()).toMatchObject({ class: 'N', predBase: base, head });
    expect(readState().predictedTree).toBeUndefined();
    expect(verified()).toEqual([]);
  });

  it('S2 happy path: main moved on other files → F; the predicted tree is verified outside the slot and is the tree that lands', () => {
    setup({ merge: { mode: 'S2' } });
    const moved = advanceMain({ 'peer.txt': 'peer\n' });
    const prepared = run(['prepare', String(PR)]);
    expect(prepared.stderr).not.toContain('想定外');
    expect(prepared.status).toBe(0);
    expect(prepared.stderr).toContain('クラス=F');
    const expectedTree = git(work, ['merge-tree', '--write-tree', moved, head]);
    const state = readState();
    expect(state).toMatchObject({ class: 'F', predBase: moved, head, predictedTree: expectedTree });
    expect(git(work, ['rev-parse', `${state.predictedCommit}^{tree}`])).toBe(expectedTree);
    expect(git(work, ['rev-list', '--parents', '-n', '1', state.predictedCommit]).split(' ').slice(1)).toEqual([moved, head]);
    expect(verified()).toEqual([state.predictedCommit]);
    expect(git(work, ['symbolic-ref', '--short', 'HEAD'])).toBe('bd/demo-1');
    expect(git(work, ['rev-parse', 'HEAD'])).toBe(head); // rebase も push もしていない
    expect(calls('bd').filter((c) => c[1] !== 'show')).toEqual([]); // prepare は枠に触れない
    expect(posted()).toEqual([]); // 着地予定コミットは GitHub に無いので台帳にも書かない
    expect(calls('gh', 'checks')).toHaveLength(1);
    expect(auditText()).toMatch(/\tpredicted-verify\t.*result=success/);

    writeFake({ statuses: { [moved]: [status('success')] } });
    const gated = run(['gate', String(PR)]);
    expect(gated.status).toBe(0);
    expect(gated.stdout).toBe(`gh pr merge ${PR} --squash --delete-branch --match-head-commit ${head} --subject '${TITLE} (#${PR})'\n`);
    const landed = landSquash();
    expect(git(work, ['rev-parse', `${landed}^{tree}`])).toBe(expectedTree);
    const finished = run(['finish', String(PR)]);
    expect(finished.status).toBe(0);
    expect(finished.stderr).toContain('着地予定ツリーと同一');
    expect(verified()).toEqual([state.predictedCommit, landed]);
    expect(posted().map(({ sha, state: s }) => [sha, s])).toEqual([
      [landed, 'pending'],
      [landed, 'success'],
    ]);
    expect(auditText()).toMatch(/\tpredicted-tree\tpr=7\tid=demo-1\tmatch=true/);
    expect(readFake().slot.holder).toBeNull();
    expect(existsSync(stateFile())).toBe(false);
  });

  it('S2 prepare: a text conflict with main is class R (exit 3); nothing is verified and CI is not asked', () => {
    setup({ merge: { mode: 'S2' } });
    advanceMain({ 'feature.txt': 'main side\n' });
    const prepared = run(['prepare', String(PR)]);
    expect(prepared.status).toBe(3);
    expect(prepared.stderr).toContain('クラス=R');
    expect(prepared.stderr).toContain('テキスト衝突: feature.txt');
    expect(prepared.stderr).toContain('git rebase origin/main');
    expect(verified()).toEqual([]);
    expect(calls('gh', 'checks')).toEqual([]);
    expect(existsSync(stateFile())).toBe(false);
  });

  it('S2 prepare: the same hot kind on both sides is class R without a text conflict; a one-sided hot file is still F', () => {
    setup({ merge: { mode: 'S2' }, branchFiles: { 'package.json': '{"name":"demo"}\n' } });
    advanceMain({ 'package-lock.json': '{"lockfileVersion":3}\n' });
    const prepared = run(['prepare', String(PR)]);
    expect(prepared.status).toBe(3);
    expect(prepared.stderr).toContain('hot file: main package-lock.json / 自分 package.json');
    expect(verified()).toEqual([]);

    setup({ merge: { mode: 'S2' } });
    advanceMain({ '.github/workflows/ci.yml': 'on: push\n' });
    expect(run(['prepare', String(PR)]).status).toBe(0);
    expect(readState().class).toBe('F');
  });

  it('S2 prepare: merge.hotFiles in the contract replaces the default list', () => {
    setup({ merge: { mode: 'S2', hotFiles: ['{feature,peer}.txt'] } });
    advanceMain({ 'peer.txt': 'peer\n' });
    const prepared = run(['prepare', String(PR)]);
    expect(prepared.status).toBe(3);
    expect(prepared.stderr).toContain('hot file: main peer.txt / 自分 feature.txt');
  });

  it('S2 prepare: a file-disjoint semantic conflict fails the predicted verify → exit 3, no state, no ledger, no slot', () => {
    setup({ merge: { mode: 'S2' } });
    advanceMain({ 'peer.txt': 'peer\n' });
    const prepared = run(['prepare', String(PR)], { FAKE_VERIFY_CONFLICT: 'feature.txt,peer.txt' });
    expect(prepared.status).toBe(3);
    expect(prepared.stderr).toContain('着地予定ツリー');
    expect(prepared.stderr).toContain('rebase に格下げ');
    expect(verified()).toHaveLength(1);
    expect(existsSync(stateFile())).toBe(false);
    expect(posted()).toEqual([]);
    expect(calls('bd').filter((c) => c[1] !== 'show')).toEqual([]);
    expect(git(work, ['symbolic-ref', '--short', 'HEAD'])).toBe('bd/demo-1');
    expect(auditText()).toMatch(/\tpredicted-verify\t.*result=failure/);
  });

  it('S2 prepare: main moving during the predicted verify is a retry (75) with no state left behind', () => {
    setup({ merge: { mode: 'S2' } });
    advanceMain({ 'peer.txt': 'peer\n' });
    const later = git(mainCheckout, ['commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', 'feat(peer2): landed during verify']);
    const prepared = run(['prepare', String(PR)], { FAKE_VERIFY_MOVE_MAIN: later });
    expect(prepared.status).toBe(75);
    expect(prepared.stderr).toContain('verify の間に');
    expect(existsSync(stateFile())).toBe(false);
    expect(git(work, ['symbolic-ref', '--short', 'HEAD'])).toBe('bd/demo-1');
  });

  it('S2 prepare: main moving while the predicted verify is still running stops it right away (75, bdboard-ulxa.6)', async () => {
    setup({ merge: { mode: 'S2' } });
    advanceMain({ 'peer.txt': 'peer\n' });
    const pidFile = path.join(tmp, 'predicted-verify.pid');
    const child = spawn(process.execPath, [SCRIPT, 'prepare', String(PR)], {
      cwd: work,
      env: { ...env, FAKE_VERIFY_SLEEP_MS: '60000', FAKE_VERIFY_PID_FILE: pidFile, BDBOARD_MERGE_KILL_GRACE_MS: '200' },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
    let verifyPid;
    try {
      await waitUntil(() => existsSync(pidFile) && Number(readFileSync(pidFile, 'utf8')) > 0);
      verifyPid = Number(readFileSync(pidFile, 'utf8'));
      advanceMain({ 'peer2.txt': 'peer2\n' }); // 別 PR が着地した
      const started = Date.now();
      expect(await exited).toBe(75);
      expect(Date.now() - started).toBeLessThan(15_000); // 60 秒の verify を最後まで待たない
      await waitUntil(() => !pidAlive(verifyPid), { timeoutMs: 5_000 });
    } finally {
      child.kill('SIGKILL');
      if (verifyPid !== undefined && pidAlive(verifyPid)) {
        process.kill(verifyPid, 'SIGKILL');
      }
    }
    expect(stderr).toContain('途中でやめました');
    expect(stderr).toContain(`npm run merge-pr -- prepare ${PR}`);
    expect(existsSync(stateFile())).toBe(false);
    expect(git(work, ['symbolic-ref', '--short', 'HEAD'])).toBe('bd/demo-1');
    expect(auditText()).toMatch(/\tpredicted-verify\t.*result=abandoned/);
  });

  it('S2: the predicted verify queues as merge with the time the PR first queued, kept across a 75 retry; finish verifies as landed and forgets it', () => {
    setup({ merge: { mode: 'S2' } });
    advanceMain({ 'peer.txt': 'peer\n' });
    const envLog = path.join(tmp, 'verify-env.log');
    const queueFile = path.join(mainCheckout, '.git', 'bdboard-merge', `pr-${PR}-queue.json`);
    const later = git(mainCheckout, ['commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', 'feat(peer2): landed during verify']);
    // bdboard-lmhs: 高負荷の verify で 2 回目の prepare が 75 を返したことがある (原因未特定)。
    // 次に落ちたとき原因が分かるよう、終了コードの不一致には merge-pr の出力と監査ログを添える。
    const expectExit = (result, code) =>
      expect(result.status, `merge-pr exited ${result.status}:\n${result.stderr}\naudit:\n${auditText()}`).toBe(code);
    // bdboard-rlvz: 偽 verify の push は tracking ref を触らない (触ると、abandon の SIGTERM 次第で lock が残る)。
    // merge-pr 自身の refetch も同じ ref を動かすので、値ではなく reflog の push 由来の更新を数える。
    const pushUpdates = () => git(mainCheckout, ['log', '-g', '--format=%gs', 'refs/remotes/origin/main']).split('\n').filter((line) => line.startsWith('update by push')).length;
    const pushUpdatesBefore = pushUpdates();
    expectExit(run(['prepare', String(PR)], { FAKE_VERIFY_ENV_LOG: envLog, FAKE_VERIFY_MOVE_MAIN: later }), 75);
    expect(pushUpdates()).toBe(pushUpdatesBefore);
    const { since } = JSON.parse(readFileSync(queueFile, 'utf8'));
    // bdboard-pwae: prepare defines exit 75 as a transient retry; retry only its exact fetch failure so other 75s still expose regressions.
    const retryFetchFailure = () => {
      let result;
      for (let attempt = 0; attempt < 5; attempt++) {
        result = run(['prepare', String(PR)], { FAKE_VERIFY_ENV_LOG: envLog });
        if (result.status !== 75 || !/^merge-pr: git fetch origin main に失敗しました:/m.test(result.stderr)) return result;
        // bdboard-rlvz: 5 回とも lock の File exists で落ちた原因 (偽 verify の名前宛て push が abandon の
        // SIGTERM で refs/remotes/origin/main.lock を残す) は直した。pwae の元の失敗もおそらく同じ原因で、
        // 残った lock は再試行では消えない。一時的な失敗のための再試行と出力の記録は害が無いので残す。
        process.stderr.write(`bdboard-pwae: prepare attempt ${attempt + 1} exited 75 on fetch, retrying:\n${result.stderr}\n`);
      }
      return result;
    };
    expectExit(retryFetchFailure(), 0);
    writeFake({ statuses: { [later]: [status('success')] } });
    expectExit(run(['gate', String(PR)]), 0);
    landSquash();
    expectExit(run(['finish', String(PR)], { FAKE_VERIFY_ENV_LOG: envLog }), 0);
    expect(readFileSync(envLog, 'utf8').trim().split('\n')).toEqual([`merge ${since}`, `merge ${since}`, 'landed -']);
    expect(existsSync(queueFile)).toBe(false);
  });

  it('S2 prepare: a dirty worktree cannot verify the predicted tree (exit 1) and a stale record from an earlier prepare is dropped', () => {
    setup({ merge: { mode: 'S2' } });
    expect(run(['prepare', String(PR)]).status).toBe(0); // 前回の prepare (クラス N) の記録
    advanceMain({ 'peer.txt': 'peer\n' });
    writeFileSync(path.join(work, 'feature.txt'), 'uncommitted\n');
    expect(run(['prepare', String(PR)]).status).toBe(1);
    expect(existsSync(stateFile())).toBe(false);
    expect(verified()).toEqual([]);
  });

  it('gate: a class-F record is sent back to prepare under S1 (rolled back) or when the predicted verify is not recorded', () => {
    setup();
    expect(run(['prepare', String(PR)]).status).toBe(0);
    writeFileSync(stateFile(), JSON.stringify({ ...readState(), class: 'F', predictedTree: 'c'.repeat(40), predictedVerifiedAt: 'x' }));
    const rolledBack = run(['gate', String(PR)]);
    expect(rolledBack.status).toBe(75);
    expect(rolledBack.stderr).toContain('クラス F');
    expect(existsSync(stateFile())).toBe(false);

    setup({ merge: { mode: 'S2' } });
    expect(run(['prepare', String(PR)]).status).toBe(0);
    writeFileSync(stateFile(), JSON.stringify({ ...readState(), class: 'F' }));
    expect(run(['gate', String(PR)]).status).toBe(75);
    expect(calls('bd', 'acquire')).toEqual([]);
  });

  it('prepare refuses while this PR is gated and holds the slot (finish first); the record survives for finish', () => {
    setup();
    expect(run(['prepare', String(PR)]).status).toBe(0);
    expect(run(['gate', String(PR)]).status).toBe(0);
    const again = run(['prepare', String(PR), '--dry-run']);
    expect(again.status).toBe(2);
    expect(again.stderr).toContain('finish');
    expect(readState().gateAt).toBeTruthy();
    expect(run(['finish', String(PR)]).status).toBe(5);
    expect(readFake().slot.holder).toBeNull();
  });

  it("S2 prepare: the predicted tree ignores the merger's rename config (merge.renames=false in ~/.gitconfig)", () => {
    setup({ merge: { mode: 'S2' }, branchFiles: { 'README.md': 'demo\nfrom the PR\n' } });
    git(mainCheckout, ['mv', 'README.md', 'DOC.md']);
    const moved = commitAll(mainCheckout, 'docs(peer): rename README');
    git(mainCheckout, ['push', '-q', 'origin', 'main']);
    // 既定の改名検出なら「改名 + 変更」で綺麗に混ざる。利用者設定のまま走ると modify/delete の衝突になる。
    // GIT_CONFIG_GLOBAL (test-support/quiet-git.mjs) が ~/.gitconfig を置き換えるので、利用者の global 設定はそちらに足す。
    appendFileSync(env.GIT_CONFIG_GLOBAL, '[merge]\n\trenames = false\n');
    expect(git(work, ['config', '--get', 'merge.renames'])).toBe('false'); // 前提 (利用者設定) が git に見えていること
    const prepared = run(['prepare', String(PR)]);
    expect(prepared.status).toBe(0);
    const expectedTree = git(work, ['-c', 'merge.renames=true', 'merge-tree', '--write-tree', moved, head]);
    expect(readState()).toMatchObject({ class: 'F', predictedTree: expectedTree });
    expect(git(work, ['show', `${expectedTree}:DOC.md`])).toBe('demo\nfrom the PR');
  });

  it('S2 prepare: GitHub saying mergeable=false demotes F to R (gh pr merge would fail with 405)', () => {
    setup({ merge: { mode: 'S2' } });
    advanceMain({ 'peer.txt': 'peer\n' });
    const fake = readFake();
    writeFake({ pulls: { ...fake.pulls, [PR]: { ...fake.pulls[PR], mergeable: false } } });
    const prepared = run(['prepare', String(PR)]);
    expect(prepared.status).toBe(3);
    expect(prepared.stderr).toContain('mergeable=false');
    expect(verified()).toEqual([]);
    expect(existsSync(stateFile())).toBe(false);
  });

  it('S2 prepare: a failed ledger on PRED_BASE is a broken main (exit 4) before any predicted verify', () => {
    setup({ merge: { mode: 'S2' } });
    const moved = advanceMain({ 'peer.txt': 'peer\n' });
    writeFake({ statuses: { [moved]: [status('failure')] } });
    const prepared = run(['prepare', String(PR)]);
    expect(prepared.status).toBe(4);
    expect(prepared.stderr).toContain('bd create --type bug -p 0');
    expect(prepared.stderr).toContain('gate --repair');
    expect(verified()).toEqual([]);
    expect(calls('bd').filter((c) => c[1] !== 'show')).toEqual([]);
    expect(existsSync(stateFile())).toBe(false);
  });

  it('prepare --dry-run previews the S2 class in any mode and never verifies or writes state', () => {
    setup();
    advanceMain({ 'peer.txt': 'peer\n' });
    const s1 = run(['prepare', String(PR), '--dry-run']);
    expect(s1.status).toBe(3); // S1 では main が動いたら R のまま
    expect(s1.stderr).toContain('参考: merge.mode が S2 ならクラス=F');

    setup({ merge: { mode: 'S2' } });
    advanceMain({ 'peer.txt': 'peer\n' });
    const s2 = run(['prepare', String(PR), '--dry-run']);
    expect(s2.status).toBe(0);
    expect(s2.stderr).toContain('クラス=F');
    expect(s2.stderr).toContain('verify もしません');
    expect(verified()).toEqual([]);
    expect(existsSync(stateFile())).toBe(false);
  });

  it('prepare: a HEAD left detached (an interrupted verify) is refused with the way back', () => {
    setup({ merge: { mode: 'S2' } });
    git(work, ['checkout', '-q', '--detach', base]);
    const prepared = run(['prepare', String(PR)]);
    expect(prepared.status).toBe(2);
    expect(prepared.stderr).toContain('git checkout bd/demo-1');
  });

  it('S2 prepare (class F): SIGINT during the predicted-tree verify kills the process and restores the branch, leaving no state behind for a clean retry', async () => {
    setup({ merge: { mode: 'S2' } });
    advanceMain({ 'peer.txt': 'peer\n' }); // 衝突なし・hot file なしで main を進める → クラス F
    const pidFile = path.join(tmp, 'predicted-verify.pid');
    const child = spawn(process.execPath, [SCRIPT, 'prepare', String(PR)], {
      cwd: work,
      env: { ...env, FAKE_VERIFY_SLEEP_MS: '60000', FAKE_VERIFY_PID_FILE: pidFile, BDBOARD_MERGE_KILL_GRACE_MS: '200' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    let verifyPid;
    try {
      await waitUntil(() => {
        if (!existsSync(pidFile)) {
          return false;
        }
        const parsed = Number(readFileSync(pidFile, 'utf8').trim());
        if (!Number.isInteger(parsed) || parsed <= 0) {
          return false;
        }
        verifyPid = parsed;
        return true;
      });
      expect(pidAlive(verifyPid)).toBe(true);

      child.kill('SIGINT');
      const [code, signal] = await new Promise((resolve) => {
        child.once('exit', (exitCode, exitSignal) => resolve([exitCode, exitSignal]));
      });
      expect(signal).toBeNull();
      expect(code).toBe(130);

      await waitUntil(() => !pidAlive(verifyPid), { timeoutMs: 5_000 });
    } finally {
      if (!child.killed) {
        child.kill('SIGKILL');
      }
      if (verifyPid !== undefined && pidAlive(verifyPid)) {
        try {
          process.kill(verifyPid, 'SIGKILL');
        } catch {
          // 確認と kill の間に終了していれば無視する。
        }
      }
    }
    expect(git(work, ['symbolic-ref', '--short', 'HEAD'])).toBe('bd/demo-1'); // 着地予定ツリーの detach のまま残らない
    expect(posted()).toEqual([]); // ledger:false なので元々何も投稿しない
    expect(stderr).toContain('SIGINT');
    expect(stderr).toContain(`そのまま次を実行してやり直せます: npm run merge-pr -- prepare ${PR}`);
    expect(stderr).not.toContain('着地予定ツリーの verify を実行できませんでした');
    expect(existsSync(stateFile())).toBe(false); // 記録が残らないのでそのまま prepare し直せる

    const retried = run(['prepare', String(PR)]);
    expect(retried.status).toBe(0);
    expect(readState()).toMatchObject({ class: 'F' });
  });

  it('S2 prepare (class F): the untracked-file guard judges by the predicted landed tree\'s .gitignore, not the branch currently checked out', () => {
    setup({ merge: { mode: 'S2' } });
    // main が新しく .gitignore を追加する (PR 側は .gitignore を触らないのでクラス F のまま)。
    // 現在チェックアウトしている bd/demo-1 には .gitignore が無いので、判定を checkout 前に
    // 行うと (旧実装) stray.log は「ignore されていない未追跡ファイル」として誤ってブロック
    // される。着地予定ツリー (main の .gitignore を含む) を detach した後に判定すれば無視される。
    advanceMain({ '.gitignore': 'stray.log\n' });
    writeFileSync(path.join(work, 'stray.log'), 'noise\n');
    const prepared = run(['prepare', String(PR)]);
    expect(prepared.status).toBe(0);
    expect(prepared.stderr).not.toContain('未追跡ファイル');
    expect(readState()).toMatchObject({ class: 'F' });
  });
});
