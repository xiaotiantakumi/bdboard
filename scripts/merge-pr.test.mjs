// bdboard-ulxa.1: scripts/merge-pr (マージ手順 S1 の prepare / gate / finish) のテスト。
//
// 本物の GitHub・bd・main checkout には触れない。一時ディレクトリに bare の origin と PR の
// worktree 役のクローンを作り、git は本物、gh / bd / npm は scripts/merge-pr/fake-tools.mjs
// (状態 JSON を読み書きする代役) で動かす。検証コマンドは偽の `node verify.cjs` で、
// どの SHA を検証したかをログに残す。Windows は統合部分を skip (bash 前提ではないが、
// 運用するのは macOS のエージェントだけで、always-on-server.test.mjs と同じ扱い)。
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { evaluateLandedStatus, mergeCommand, parseGitHubSlug, parseMergeConfig } from './merge-pr.mjs';

const SCRIPT = fileURLToPath(new URL('./merge-pr.mjs', import.meta.url));
const FAKE = fileURLToPath(new URL('./merge-pr/fake-tools.mjs', import.meta.url));
const REPO_ROOT = path.dirname(path.dirname(SCRIPT));
const CONTEXT = 'bdboard/landed-verify';
const PR = 7;
const TITLE = 'feat(demo-1): add the thing';

const VERIFY_JS = `
const fs = require('node:fs');
const { execSync } = require('node:child_process');
const head = execSync('git rev-parse HEAD').toString().trim();
fs.appendFileSync(process.env.FAKE_VERIFY_LOG, head + '\\n');
process.exit(Number(process.env.FAKE_VERIFY_EXIT || 0));
`;

describe('merge-pr pure helpers', () => {
  const lease = 8 * 60_000;
  const now = Date.parse('2026-09-24T12:00:00Z');

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
      config: { mode: 'S0', leaseMinutes: 8, slotWaitMinutes: 10, statusContext: CONTEXT, verify: 'npm run verify', mainBranch: 'main', repo: null },
    });
    expect(parseMergeConfig({ ...base, merge: { mode: 'S1', repo: 'o/r' } }).config).toMatchObject({ mode: 'S1', repo: 'o/r' });
    expect(parseMergeConfig({ ...base, merge: { mode: 'S2' } }).ok).toBe(false);
    expect(parseMergeConfig({ ...base, merge: { leaseMinutes: 0 } }).ok).toBe(false);
    expect(parseMergeConfig({ ...base, merge: { statusContext: 'has space' } }).ok).toBe(false);
    expect(parseMergeConfig({ ...base, merge: { repo: 'no-slash' } }).ok).toBe(false);
    expect(parseMergeConfig({ ...base, merge: [] }).ok).toBe(false);
    expect(parseMergeConfig({ ...base, verify: '' }).ok).toBe(false);
  });

  it("this repo's own contract has a valid merge block (the S0/S1 switch is one line)", () => {
    const contract = JSON.parse(readFileSync(path.join(REPO_ROOT, '.claude', 'bdboard-harness.json'), 'utf8'));
    const parsed = parseMergeConfig(contract);
    expect(parsed.ok).toBe(true);
    expect(['S0', 'S1']).toContain(parsed.config.mode);
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
    expect(mergeCommand(3, 'f00', "docs(y): it's $HOME `x`")).toBe(
      "gh pr merge 3 --squash --delete-branch --match-head-commit f00 --subject 'docs(y): it'\\''s $HOME `x` (#3)'",
    );
  });
});

// 1 テストで node / git を十数回起こす。verify の並列実行中でも既定 5 秒で落ちないよう余裕を取る。
describe.skipIf(process.platform === 'win32')('merge-pr phases against a temp repo + fake gh/bd/npm', { timeout: 30_000 }, () => {
  let tmp;
  let work;
  let fakeState;
  let env;
  let base;
  let head;

  function git(cwd, args, extraEnv = {}) {
    const result = spawnSync('git', args, { cwd, env: { ...env, ...extraEnv }, encoding: 'utf8' });
    if (result.status !== 0) {
      throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
    }
    return result.stdout.trim();
  }

  const readFake = () => JSON.parse(readFileSync(fakeState, 'utf8'));
  const writeFake = (patch) => writeFileSync(fakeState, JSON.stringify({ ...readFake(), ...patch }, null, 2));
  const calls = (tool, sub) => readFake().calls.filter((call) => call[0] === tool && (sub === undefined || call.includes(sub)));
  const posted = () => readFake().posted ?? [];
  const verified = () => (existsSync(env.FAKE_VERIFY_LOG) ? readFileSync(env.FAKE_VERIFY_LOG, 'utf8').trim().split('\n') : []);
  const auditText = () => (existsSync(env.BDBOARD_MERGE_AUDIT_LOG) ? readFileSync(env.BDBOARD_MERGE_AUDIT_LOG, 'utf8') : '');
  const stateFile = () => path.join(work, '.git', 'bdboard-merge', `pr-${PR}.json`);
  const status = (state, updatedAt = new Date().toISOString()) => ({ state, context: CONTEXT, description: state, updated_at: updatedAt });

  function run(args, extraEnv = {}) {
    const result = spawnSync(process.execPath, [SCRIPT, ...args], {
      cwd: work,
      env: { ...env, ...extraEnv },
      encoding: 'utf8',
      timeout: 60_000,
    });
    return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  }

  function commitAll(cwd, message, extraEnv = {}) {
    git(cwd, ['add', '-A']);
    git(cwd, ['commit', '-q', '-m', message], extraEnv);
    return git(cwd, ['rev-parse', 'HEAD']);
  }

  /**
   * origin (bare) と PR worktree 役の work を作る。main の先頭 (= PRED_BASE) は mainDate の時刻。
   * work は bd/demo-1 (feature.txt を足した 1 コミット) を checkout した状態で返す。
   */
  function setup({ merge = {}, mainDate, branchFiles = {} } = {}) {
    if (tmp) {
      rmSync(tmp, { recursive: true, force: true });
    }
    tmp = mkdtempSync(path.join(tmpdir(), 'bdboard-merge-pr-'));
    const origin = path.join(tmp, 'origin.git');
    work = path.join(tmp, 'work');
    fakeState = path.join(tmp, 'fake-state.json');
    mkdirSync(path.join(tmp, 'home'));
    const tool = (name) => JSON.stringify([process.execPath, FAKE, name]);
    env = {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: path.join(tmp, 'home'),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'bdboard-test',
      GIT_AUTHOR_EMAIL: 'bdboard-test@example.invalid',
      GIT_COMMITTER_NAME: 'bdboard-test',
      GIT_COMMITTER_EMAIL: 'bdboard-test@example.invalid',
      BDBOARD_MERGE_GH: tool('gh'),
      BDBOARD_MERGE_BD: tool('bd'),
      BDBOARD_MERGE_NPM: tool('npm'),
      BDBOARD_MERGE_FAKE_STATE: fakeState,
      BDBOARD_MERGE_AUDIT_LOG: path.join(tmp, 'audit.log'),
      BDBOARD_MERGE_POLL_MS: '50',
      FAKE_VERIFY_LOG: path.join(tmp, 'verified.log'),
    };
    git(tmp, ['init', '-q', '--bare', '-b', 'main', origin]);
    git(tmp, ['init', '-q', '-b', 'main', work]);
    const contract = {
      version: 1,
      verify: 'node verify.cjs',
      prFlow: 'pr',
      merge: { mode: 'S1', leaseMinutes: 1, slotWaitMinutes: 1, statusContext: CONTEXT, repo: 'example/demo', ...merge },
    };
    mkdirSync(path.join(work, '.claude'));
    writeFileSync(path.join(work, '.claude', 'bdboard-harness.json'), `${JSON.stringify(contract, null, 2)}\n`);
    writeFileSync(path.join(work, 'verify.cjs'), VERIFY_JS);
    writeFileSync(path.join(work, 'README.md'), 'demo\n');
    base = commitAll(work, 'chore: init', mainDate ? { GIT_COMMITTER_DATE: mainDate } : {});
    git(work, ['remote', 'add', 'origin', origin]);
    git(work, ['push', '-q', 'origin', 'main']);
    git(work, ['switch', '-q', '-c', 'bd/demo-1']);
    writeFileSync(path.join(work, 'feature.txt'), 'feature\n');
    for (const [file, content] of Object.entries(branchFiles)) {
      writeFileSync(path.join(work, file), content);
    }
    head = commitAll(work, TITLE);
    git(work, ['push', '-q', 'origin', 'bd/demo-1']);
    writeFileSync(
      fakeState,
      JSON.stringify({
        pulls: {
          [PR]: { number: PR, state: 'open', merged: false, merge_commit_sha: null, title: TITLE, draft: false, head: { sha: head, ref: 'bd/demo-1' }, base: { ref: 'main' } },
        },
        statuses: { [base]: [status('success')] },
        slot: { holder: null },
        calls: [],
      }),
    );
  }

  /** gh pr merge の代わりに squash マージを origin に着地させ、PR をマージ済みにする。 */
  function simulateMerge() {
    const tree = git(work, ['rev-parse', 'HEAD^{tree}']);
    const landed = git(work, ['commit-tree', tree, '-p', base, '-m', `${TITLE} (#${PR})`]);
    git(work, ['push', '-q', 'origin', `${landed}:refs/heads/main`]);
    const fake = readFake();
    fake.pulls[PR] = { ...fake.pulls[PR], state: 'closed', merged: true, merge_commit_sha: landed };
    writeFileSync(fakeState, JSON.stringify(fake));
    return landed;
  }

  /** main を base から 1 コミット進めた commit を作る (push はしない)。 */
  function peerCommit() {
    return git(work, ['commit-tree', `${base}^{tree}`, '-p', base, '-m', 'feat(peer): landed meanwhile']);
  }

  afterEach(() => {
    if (tmp) {
      rmSync(tmp, { recursive: true, force: true });
    }
    tmp = undefined;
  });

  beforeEach(() => {
    tmp = undefined;
  });

  it('rejects usage errors before touching git', () => {
    setup();
    expect(run(['--help']).status).toBe(0);
    expect(run([]).status).toBe(1);
    expect(run(['bogus', '7']).status).toBe(1);
    expect(run(['gate', 'x']).status).toBe(1);
    expect(run(['prepare', '7', '--force']).status).toBe(1);
    expect(readFake().calls).toEqual([]);
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
    expect(calls('bd')).toEqual([]);
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
    expect(audit).toMatch(/finish-released\tpr=7\tid=demo-1\tmerged=true\theld_s=\d+/);
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

  it('finish: an unmerged PR (merge refused / 409) just returns the slot', () => {
    setup();
    expect(run(['prepare', String(PR)]).status).toBe(0);
    expect(run(['gate', String(PR)]).status).toBe(0);
    const finished = run(['finish', String(PR)]);
    expect(finished.status).toBe(5);
    expect(finished.stderr).toContain('マージされていません');
    expect(readFake().slot.holder).toBeNull();
    expect(posted()).toEqual([]);
    expect(existsSync(stateFile())).toBe(false);
  });

  it('finish: a failing landed-verify records failure and holds the slot for the repair (§3.6)', () => {
    setup();
    expect(run(['prepare', String(PR)]).status).toBe(0);
    expect(run(['gate', String(PR)]).status).toBe(0);
    const landed = simulateMerge();
    const finished = run(['finish', String(PR)], { FAKE_VERIFY_EXIT: '1' });
    expect(finished.status).toBe(6);
    expect(finished.stderr).toContain('revert');
    expect(posted().map(({ sha, state }) => [sha, state])).toEqual([
      [landed, 'pending'],
      [landed, 'failure'],
    ]);
    expect(readFake().slot.holder).toBe(`demo-1 / main-broken ${landed.slice(0, 12)}`);
    expect(git(work, ['symbolic-ref', '--short', 'HEAD'])).toBe('bd/demo-1');
  });

  it('finish: refuses to start while the working tree is dirty and leaves the ledger pending-free', () => {
    setup();
    expect(run(['prepare', String(PR)]).status).toBe(0);
    expect(run(['gate', String(PR)]).status).toBe(0);
    simulateMerge();
    writeFileSync(path.join(work, 'feature.txt'), 'uncommitted\n');
    const finished = run(['finish', String(PR)]);
    expect(finished.status).toBe(1);
    expect(finished.stderr).toContain('npm run merge-pr -- verify');
    expect(readFake().slot.holder).toBeNull();
    expect(posted()).toEqual([]);
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
});
