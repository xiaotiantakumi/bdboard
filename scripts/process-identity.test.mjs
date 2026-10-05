// bdboard-ky9l: scripts/process-identity.mjs (生存確認の共通化)。開始時刻による同一性の判定の半分は bdboard-wea0.2 で
// worktree lock に置き換えて消した (テストは scripts/merge-pr.worktree-lock.test.mjs)。
import { spawn, spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

import { isProcessAlive, isProcessGroupAlive } from './process-identity.mjs';

// 既に死んでいる pid (即終了する node を同期実行した pid)。
const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid;

describe('isProcessAlive', () => {
  it('is true for this process and false for a process that is gone', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(deadPid())).toBe(false);
  });

  it('is false for anything that is not a positive integer pid (0 would signal our own process group)', () => {
    for (const pid of [0, -1, 1.5, Number.NaN, undefined, null, '123']) {
      expect(isProcessAlive(pid)).toBe(false);
    }
  });

  it.skipIf(process.platform === 'win32')('treats EPERM (a process we cannot signal) as alive', () => {
    // pid 1 (init / launchd) は一般ユーザーからは signal 0 でも EPERM になる。root で走る CI では通るだけ。
    expect(isProcessAlive(1)).toBe(true);
  });
});

describe('isProcessGroupAlive', () => {
  it('is false for anything that is not a positive integer, and always false on win32 (no process groups)', () => {
    for (const pgid of [0, -1, Number.NaN, undefined]) {
      expect(isProcessGroupAlive(pgid)).toBe(false);
    }
    expect(isProcessGroupAlive(process.pid, { platform: 'win32' })).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('is true while a group has a member and false once it is gone', async () => {
    const leader = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { detached: true, stdio: 'ignore' });
    try {
      expect(isProcessGroupAlive(leader.pid)).toBe(true);
      const exited = new Promise((resolve) => leader.once('exit', resolve));
      process.kill(-leader.pid, 'SIGKILL');
      await exited;
      expect(isProcessGroupAlive(leader.pid)).toBe(false);
    } finally {
      leader.kill('SIGKILL');
    }
  });
});
