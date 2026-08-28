import { describe, expect, it, vi } from 'vitest';
import { isOrphaned, killProcessTree } from './process-tree.mjs';

function esrch() {
  const error = new Error('no such process');
  error.code = 'ESRCH';
  return error;
}

describe('killProcessTree', () => {
  // 移設前の killGroup と逐語同じ分岐であることを固定する。POSIX 側の挙動が
  // 1 ビットでも変わると bdboard-kia の孤児ワーカー事故が戻る。
  it('sends the signal to the whole process group on posix', () => {
    const kill = vi.fn();
    killProcessTree(4321, 'SIGTERM', { platform: 'linux', kill });
    expect(kill).toHaveBeenCalledTimes(1);
    expect(kill).toHaveBeenCalledWith(-4321, 'SIGTERM');
  });

  it('ignores ESRCH without falling back to a single-process kill on posix', () => {
    const kill = vi.fn(() => { throw esrch(); });
    killProcessTree(4321, 'SIGKILL', { platform: 'darwin', kill });
    expect(kill).toHaveBeenCalledTimes(1);
    expect(kill).toHaveBeenCalledWith(-4321, 'SIGKILL');
  });

  it('falls back to a single-process kill on a non-ESRCH error on posix', () => {
    const kill = vi.fn((pid) => {
      if (pid < 0) {
        const error = new Error('operation not permitted');
        error.code = 'EPERM';
        throw error;
      }
    });
    killProcessTree(4321, 'SIGTERM', { platform: 'darwin', kill });
    expect(kill).toHaveBeenNthCalledWith(1, -4321, 'SIGTERM');
    expect(kill).toHaveBeenNthCalledWith(2, 4321, 'SIGTERM');
  });

  it('uses taskkill /T /F instead of signals on win32', () => {
    // win32 では process.kill(-pid) が libuv で ESRCH になり丸ごと no-op だった
    // (bdboard-6l7)。シグナル経路を一切使わないことまで固定する。
    const kill = vi.fn();
    const child = { on: vi.fn(), unref: vi.fn() };
    const spawnFn = vi.fn(() => child);
    killProcessTree(4321, 'SIGTERM', { platform: 'win32', kill, spawn: spawnFn });

    expect(kill).not.toHaveBeenCalled();
    expect(spawnFn).toHaveBeenCalledWith(
      'taskkill',
      ['/pid', '4321', '/T', '/F'],
      { windowsHide: true, stdio: 'ignore' },
    );
    expect(child.unref).toHaveBeenCalled();
  });

  it('uses /F on win32 even for the SIGTERM-equivalent request', () => {
    const child = { on: vi.fn(), unref: vi.fn() };
    const spawnFn = vi.fn(() => child);
    killProcessTree(9, 'SIGTERM', { platform: 'win32', spawn: spawnFn });
    killProcessTree(9, 'SIGKILL', { platform: 'win32', spawn: spawnFn });
    expect(spawnFn.mock.calls[0][1]).toEqual(spawnFn.mock.calls[1][1]);
  });

  it('does not throw when taskkill itself cannot be spawned on win32', () => {
    const spawnFn = vi.fn(() => { throw new Error('ENOENT'); });
    expect(() => killProcessTree(1, 'SIGKILL', { platform: 'win32', spawn: spawnFn })).not.toThrow();
  });

  it("registers an 'error' handler on the taskkill child on win32", () => {
    // 実物の ENOENT は同期 throw ではなく 'error' イベントで届く。ハンドラを
    // 登録し忘れると unhandled 'error' が verify 自体をクラッシュさせるので、
    // 上の同期 throw のテストとは別に登録そのものを固定する
    // (fable レビュー指摘, bdboard-6l7)。
    const child = { on: vi.fn(), unref: vi.fn() };
    killProcessTree(1, 'SIGKILL', { platform: 'win32', spawn: vi.fn(() => child) });
    expect(child.on).toHaveBeenCalledWith('error', expect.any(Function));
  });
});

describe('isOrphaned', () => {
  it('uses PPID === 1 on posix', () => {
    expect(isOrphaned(500, { platform: 'linux', currentPpid: 1 })).toBe(true);
    expect(isOrphaned(500, { platform: 'linux', currentPpid: 500 })).toBe(false);
  });

  it('does not consult the initial ppid on posix', () => {
    const kill = vi.fn();
    isOrphaned(500, { platform: 'linux', currentPpid: 500, kill });
    expect(kill).not.toHaveBeenCalled();
  });

  it('probes the recorded parent with signal 0 on win32', () => {
    // Windows は reparent しないので PPID は 1 にならない。生存確認に切り替える。
    const alive = vi.fn();
    expect(isOrphaned(4444, { platform: 'win32', kill: alive })).toBe(false);
    expect(alive).toHaveBeenCalledWith(4444, 0);

    const gone = vi.fn(() => { throw esrch(); });
    expect(isOrphaned(4444, { platform: 'win32', kill: gone })).toBe(true);
  });

  it('treats EPERM as still alive on win32', () => {
    const denied = vi.fn(() => {
      const error = new Error('operation not permitted');
      error.code = 'EPERM';
      throw error;
    });
    expect(isOrphaned(4444, { platform: 'win32', kill: denied })).toBe(false);
  });

  it('never reports orphaned on win32 when the initial ppid is unusable', () => {
    const kill = vi.fn();
    expect(isOrphaned(undefined, { platform: 'win32', kill })).toBe(false);
    expect(isOrphaned(0, { platform: 'win32', kill })).toBe(false);
    expect(kill).not.toHaveBeenCalled();
  });
});
