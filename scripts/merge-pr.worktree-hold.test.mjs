// bdboard-wea0.2: restore のための SH→EX (merge-pr/worktree-restore.mjs の restoreStep) と、契約の verify を走らせてよいかの
// 判定 (worktree-hold.mjs の contractVerifyBlocker) を、偽の lock で 1 手ずつ確かめる (#872 再レビュー a・b)。実プロセスでの確認は
// merge-pr.worktree-lock.test.mjs (T3d が「SH が残っている間は保留」)。ここは実プロセスでは作りにくい「EX が拒否された隙に
// 別の保持者が持ち主の行を書いた」場合を扱う。
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RM_OPTIONS } from './test-support/quiet-git.mjs';

vi.mock('./merge-pr/exec.mjs', () => ({
  run: vi.fn((cmd, args) => ({ status: 0, stdout: args[0] === 'rev-parse' ? 'abcdef0123456789\n' : '', stderr: '' })),
}));

const { run } = await import('./merge-pr/exec.mjs');
const { contractVerifyBlocker, downgradeForVerify } = await import('./merge-pr/worktree-hold.mjs');
const { restoreAfterInterrupt, restoreUnderLock } = await import('./merge-pr/worktree-restore.mjs');

let dir;
let lockPath;
let stderr;
const target = { restoreTo: 'bd/demo-1', sha: 'fedcba9876543210' };
const ours = (phase) => ({ by: 'merge-pr finish 7', pid: process.pid, phase, sha: 'x', cwd: '/w', at: 't' });
const verifyOwner = { by: 'npm run verify', pid: 4242, phase: 'verify', sha: 'x', cwd: '/w', at: 't' };
const otherMergePr = { by: 'merge-pr prepare 9', pid: 4343, phase: 'checkout', sha: 'x', cwd: '/w', at: 't' };
const writeLine = (owner) => writeFileSync(lockPath, `${JSON.stringify(owner)}\n`);
const checkouts = () => run.mock.calls.filter(([, args]) => args[0] === 'checkout').map(([, args]) => args.at(-1));
const said = () => stderr.mock.calls.map(([text]) => String(text)).join('');

/**
 * 偽の lock。steps は tryLock の結果を順に返す ({ ok, intruder? }: intruder があれば、その結果を返す前に持ち主の行を
 * 書き換える = 拒否された隙に別の保持者が入った)。尽きたら busy。
 */
function fakeHold(steps) {
  const calls = [];
  const lock = {
    supported: true,
    fd: 9,
    path: lockPath,
    mode: 'SH',
    tryLock(mode) {
      calls.push(mode);
      const step = steps.shift() ?? { ok: false };
      if (step.intruder) {
        writeLine(step.intruder);
      }
      lock.mode = step.ok ? mode : null;
      return { ok: step.ok, outcome: step.ok ? 'ok' : 'busy' };
    },
    writeOwner(line) {
      if (lock.mode !== 'EX') {
        return false;
      }
      writeLine(line);
      return true;
    },
    release() {
      calls.push('release');
      lock.mode = null;
    },
  };
  return { hold: { lock, path: lockPath, cwd: dir, by: 'merge-pr finish 7', phase: 'verify', lost: false }, calls };
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'merge-pr-hold-'));
  lockPath = path.join(dir, 'bdboard-worktree.lock');
  writeLine(ours('verify'));
  stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  run.mockClear();
});

afterEach(() => {
  vi.resetAllMocks();
  vi.restoreAllMocks();
  rmSync(dir, RM_OPTIONS);
});

describe('restoreUnderLock (decision a: keep SH between attempts, read the owner after each re-take)', () => {
  it('a refused SH→EX re-takes SH at once, and the next attempt converts and restores', async () => {
    const { hold, calls } = fakeHold([{ ok: false }, { ok: true }, { ok: true }]);
    await restoreUnderLock(hold, target);
    expect(calls).toEqual(['EX', 'SH', 'EX']);
    expect(checkouts()).toEqual(['bd/demo-1']);
    expect(hold.phase).toBe('done');
  });

  it('a verify that overwrote the owner line in the gap is named once; merge-pr keeps waiting and restores after it', async () => {
    const { hold, calls } = fakeHold([{ ok: false, intruder: verifyOwner }, { ok: true }, { ok: false }, { ok: true }, { ok: true }]);
    await restoreUnderLock(hold, target);
    expect(calls).toEqual(['EX', 'SH', 'EX', 'SH', 'EX']);
    expect(said().match(/持ち主の行が上書きされました/g)).toHaveLength(1);
    expect(said()).toContain('npm run verify (pid 4242');
    expect(said()).toContain('がこの worktree の lock を取っていました');
    expect(checkouts()).toEqual(['bd/demo-1']);
  });

  it('another active merge-pr in the gap → the tree is theirs: release, no restore, a pending line', async () => {
    const { hold, calls } = fakeHold([{ ok: false, intruder: otherMergePr }, { ok: true }]);
    await restoreUnderLock(hold, target);
    expect(calls).toEqual(['EX', 'SH', 'release', 'release']);
    expect(hold.lost).toBe(true);
    expect(checkouts()).toEqual([]);
    expect(said()).toContain('restore を保留しました: 作業ツリーは fedcba987654 で detach したままです (別の merge-pr が持ち主になりました: merge-pr prepare 9');
    expect(said()).toContain('が空になったら git checkout bd/demo-1 で戻してください');
  });

  it('a foreign merge-pr line already in phase done is not "lost": merge-pr keeps waiting and restores (#876 review M1c)', async () => {
    const { hold, calls } = fakeHold([{ ok: false, intruder: { ...otherMergePr, phase: 'done' } }, { ok: true }, { ok: true }]);
    await restoreUnderLock(hold, target);
    expect(calls).toEqual(['EX', 'SH', 'EX']);
    expect(hold.lost).toBe(false);
    expect(checkouts()).toEqual(['bd/demo-1']);
  });

  it('an EX that never comes within BDBOARD_MERGE_RESTORE_WAIT_MS → release and a pending line, the branch is not restored', async () => {
    vi.stubEnv('BDBOARD_MERGE_RESTORE_WAIT_MS', '0');
    const { hold, calls } = fakeHold([{ ok: false }, { ok: true }]);
    await restoreUnderLock(hold, target);
    vi.unstubAllEnvs();
    expect(calls).toEqual(['EX', 'SH', 'release']);
    expect(checkouts()).toEqual([]);
    expect(said()).toContain('(まだ誰かが lock を持っています (SH))');
  });

  it('after a lost downgrade (hold.lost) it touches neither the lock nor the tree', async () => {
    const { hold, calls } = fakeHold([]);
    hold.lost = true;
    await restoreUnderLock(hold, target);
    expect(calls).toEqual([]);
    expect(checkouts()).toEqual([]);
  });
});

describe('downgradeForVerify refused (#876 review M9)', () => {
  it('a refused EX→SH exits 75, marks the hold lost, and the restore then touches neither the lock nor the tree', async () => {
    const { hold, calls } = fakeHold([{ ok: false }]);
    hold.lock.mode = 'EX';
    hold.phase = 'checkout';
    let thrown;
    try {
      downgradeForVerify(hold);
    } catch (error) {
      thrown = error;
    }
    expect(thrown?.code).toBe(75);
    expect(thrown?.lines.join('\n')).toContain('作業ツリーは戻しません (detach したまま)');
    expect(hold.lost).toBe(true);
    expect(calls).toEqual(['SH']);
    await restoreUnderLock(hold, target);
    restoreAfterInterrupt(hold, target);
    expect(calls).toEqual(['SH']);
    expect(checkouts()).toEqual([]);
  });
});

describe('restoreAfterInterrupt (the synchronous SIGINT/SIGTERM path)', () => {
  it('upgrades to EX before restoring, re-taking SH after a refusal', () => {
    const { hold, calls } = fakeHold([{ ok: false }, { ok: true }, { ok: true }]);
    restoreAfterInterrupt(hold, target);
    expect(calls).toEqual(['EX', 'SH', 'EX']);
    expect(checkouts()).toEqual(['bd/demo-1']);
  });

  it('gives up after its short budget with the pending line instead of restoring under a holder', () => {
    const { hold } = fakeHold(Array.from({ length: 100 }, (_, i) => ({ ok: i % 2 === 1 })));
    restoreAfterInterrupt(hold, target);
    expect(checkouts()).toEqual([]);
    expect(said()).toContain('restore を保留しました');
  });
});

describe('contractVerifyBlocker (decision b: the contract verify runs only under our SH with our owner line)', () => {
  it('passes with SH held and our phase-verify line', () => {
    expect(contractVerifyBlocker(fakeHold([]).hold)).toBeNull();
  });

  it('blocks when SH is not held, when the downgrade was lost, or when the line is not ours in phase verify', () => {
    const noLock = fakeHold([]).hold;
    noLock.lock.mode = null;
    expect(contractVerifyBlocker(noLock)).toContain('SH で持っていません (なし)');
    const lost = fakeHold([]).hold;
    lost.lost = true;
    expect(contractVerifyBlocker(lost)).toContain('SH で持っていません');
    writeLine(verifyOwner);
    expect(contractVerifyBlocker(fakeHold([]).hold)).toContain('この merge-pr の verify ではありません (npm run verify');
    writeLine(ours('done'));
    expect(contractVerifyBlocker(fakeHold([]).hold)).toContain('phase done');
  });

  it('never blocks where the lock is unsupported (Windows runs unlocked)', () => {
    const { hold } = fakeHold([]);
    hold.lock.supported = false;
    hold.lock.mode = null;
    expect(contractVerifyBlocker(hold)).toBeNull();
  });
});
