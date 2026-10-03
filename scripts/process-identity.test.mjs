// bdboard-ky9l: scripts/process-identity.mjs (生存確認の共通化と、プロセス開始時刻による同一性の判定)。
import { spawn, spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

import {
  compareStartTime,
  isProcessAlive,
  isProcessGroupAlive,
  processStartTime,
  START_TIME_TOLERANCE_MS,
} from './process-identity.mjs';

// 既に死んでいる pid (即終了する node を同期実行した pid)。
const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid;

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** ISO 8601 を ps -o lstart= の形 (UTC・日は 2 桁に空白詰め) にする。 */
function lstart(iso) {
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  const time = [d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()].map(pad).join(':');
  return `${DAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2, ' ')} ${time} ${d.getUTCFullYear()}`;
}

/** ps の応答を差し替える spawnSync。呼ばれた引数を calls に残す。 */
function fakePs(response, calls = []) {
  return (command, args, options) => {
    calls.push({ command, args, options });
    return typeof response === 'function' ? response() : response;
  };
}

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

describe('processStartTime', () => {
  it('asks ps for lstart in a fixed locale and timezone, and returns it as ISO 8601', () => {
    const calls = [];
    const start = processStartTime(4321, { platform: 'linux', spawnSync: fakePs({ status: 0, stdout: 'Sat Oct  4 12:00:00 2026\n' }, calls) });
    expect(start).toBe('2026-10-04T12:00:00.000Z');
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe('ps');
    expect(calls[0].args).toEqual(['-p', '4321', '-o', 'lstart=']);
    expect(calls[0].options.env).toMatchObject({ LC_ALL: 'C', TZ: 'UTC' });
  });

  it('keeps an unparseable but non-empty answer as it is (still comparable by equality)', () => {
    expect(processStartTime(7, { platform: 'linux', spawnSync: fakePs({ status: 0, stdout: '  not   a date \n' }) })).toBe('not a date');
  });

  it('is null when ps cannot answer: failure exit, empty output, spawn error, throw, or a bad pid', () => {
    const answers = [
      { status: 1, stdout: '' }, // pid が居ない
      { status: 0, stdout: '  \n' },
      { status: null, stdout: '', error: new Error('ENOENT') }, // ps が無い / タイムアウト
      { status: 0, stdout: undefined },
    ];
    for (const answer of answers) {
      expect(processStartTime(10, { platform: 'darwin', spawnSync: fakePs(answer) })).toBeNull();
    }
    const throws = fakePs(() => {
      throw new Error('boom');
    });
    expect(processStartTime(10, { platform: 'darwin', spawnSync: throws })).toBeNull();
    const never = fakePs(() => {
      throw new Error('must not run ps');
    });
    for (const pid of [0, -5, Number.NaN, undefined]) {
      expect(processStartTime(pid, { platform: 'linux', spawnSync: never })).toBeNull();
    }
  });

  it('is null on win32 without running anything (the caller falls back to the age cut-off)', () => {
    const never = fakePs(() => {
      throw new Error('must not run ps on win32');
    });
    expect(processStartTime(process.pid, { platform: 'win32', spawnSync: never })).toBeNull();
  });

  const hasPs = processStartTime(process.pid) !== null;
  it.skipIf(process.platform === 'win32' || !hasPs)('reports a real start time for this process: in the past, and about process.uptime() ago', () => {
    const start = Date.parse(processStartTime(process.pid));
    const elapsedS = (Date.now() - start) / 1000;
    expect(elapsedS).toBeGreaterThanOrEqual(-2);
    expect(Math.abs(elapsedS - process.uptime())).toBeLessThan(30);
    expect(processStartTime(process.pid)).toBe(processStartTime(process.pid)); // 同じプロセスなら毎回同じ文字列
  });
});

describe('compareStartTime', () => {
  const at = (iso) => ({ platform: 'linux', spawnSync: fakePs({ status: 0, stdout: `${lstart(iso)}\n` }) });

  it('is same for an identical start, different for another process, and tolerates the 1-second drift of procps', () => {
    const recorded = '2026-10-04T12:00:00.000Z';
    expect(compareStartTime(5, recorded, at('2026-10-04T12:00:00Z'))).toBe('same');
    expect(compareStartTime(5, recorded, at('2026-10-04T12:00:01Z'))).toBe('same');
    expect(compareStartTime(5, recorded, at(new Date(Date.parse(recorded) + START_TIME_TOLERANCE_MS).toISOString()))).toBe('same');
    expect(compareStartTime(5, recorded, at(new Date(Date.parse(recorded) + START_TIME_TOLERANCE_MS + 1_000).toISOString()))).toBe('different');
    expect(compareStartTime(5, recorded, at('2026-10-04T13:00:00Z'))).toBe('different'); // PID が再利用された
    expect(compareStartTime(5, recorded, at('2026-10-04T11:00:00Z'))).toBe('different');
  });

  it('is unknown, never different, when either side cannot be determined', () => {
    const unavailable = { platform: 'linux', spawnSync: fakePs({ status: 1, stdout: '' }) };
    expect(compareStartTime(5, '2026-10-04T12:00:00.000Z', unavailable)).toBe('unknown'); // ps が答えない
    expect(compareStartTime(5, '2026-10-04T12:00:00.000Z', { platform: 'win32' })).toBe('unknown'); // Windows
    for (const recorded of [undefined, null, '', 42]) {
      expect(compareStartTime(5, recorded, at('2026-10-04T12:00:00Z'))).toBe('unknown'); // 旧形式の記録
    }
  });

  it('compares unparseable answers by equality', () => {
    const odd = { platform: 'linux', spawnSync: fakePs({ status: 0, stdout: 'odd format\n' }) };
    expect(compareStartTime(5, 'odd format', odd)).toBe('same');
    expect(compareStartTime(5, 'another format', odd)).toBe('different');
  });
});
