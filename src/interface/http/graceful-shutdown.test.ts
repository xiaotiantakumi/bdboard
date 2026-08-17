import { describe, expect, it, vi } from 'vitest';
import {
  createGracefulShutdown,
  DEFAULT_SHUTDOWN_TIMEOUT_MS,
  type GracefulShutdownServer,
} from './graceful-shutdown.js';

function createFakeServer(overrides?: {
  close?: GracefulShutdownServer['close'];
}): GracefulShutdownServer & { closeAllConnectionsCalls: number } {
  const fake = {
    closeAllConnectionsCalls: 0,
    close: overrides?.close ?? ((callback: (err?: Error) => void) => callback()),
    closeAllConnections: () => {
      fake.closeAllConnectionsCalls += 1;
    },
  };
  return fake;
}

describe('createGracefulShutdown', () => {
  it('drains normally and exits 0 without forcing connections closed when close() resolves promptly', async () => {
    vi.useFakeTimers();
    try {
      const drainOrder: string[] = [];
      const drain = vi.fn(async () => {
        drainOrder.push('drain');
      });
      const server = createFakeServer({
        close: (callback) => {
          drainOrder.push('server.close');
          callback();
        },
      });
      const exit = vi.fn();

      const shutdown = createGracefulShutdown({
        drain,
        server,
        timeoutMs: 5_000,
        exit,
      });

      shutdown();

      // Let the microtask queue (drain -> server.close -> finish) flush.
      await vi.advanceTimersByTimeAsync(0);

      expect(drain).toHaveBeenCalledTimes(1);
      expect(drainOrder).toEqual(['drain', 'server.close']);
      expect(server.closeAllConnectionsCalls).toBe(0);
      expect(exit).toHaveBeenCalledExactlyOnceWith(0);

      // Advancing past the timeout afterwards must not fire it again (timer was cleared).
      await vi.advanceTimersByTimeAsync(10_000);
      expect(exit).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  // このテストが load-bearing であることの確認 (報告参照): server.close() の
  // callback を意図的に「絶対に呼ばれない」実装に差し替えて、SSE接続が drain されず
  // server.close() が永久にペンディングする状況(bdboard-3tw.91 の実インシデント)を
  // 再現している。タイムアウト機構が無い/壊れていると、このテストは
  // vitest のデフォルトタイムアウト(5秒)で fail するか、exit が呼ばれないまま終わる。
  it('forces existing connections closed and exits when drain never resolves close() (stuck SSE connection)', async () => {
    vi.useFakeTimers();
    try {
      const drain = vi.fn(async () => {
        // stopWatcher/tunnelService.stop/cache.close はすぐ終わる想定
      });
      const server = createFakeServer({
        // SSE 接続が生きている限り、Node の実装では close() のコールバックは
        // 呼ばれない。ここではそれを「絶対に呼ばれないコールバック」で模す。
        close: () => {
          /* never calls back */
        },
      });
      const exit = vi.fn();
      const onTimeout = vi.fn();

      const shutdown = createGracefulShutdown({
        drain,
        server,
        timeoutMs: 5_000,
        exit,
        onTimeout,
      });

      shutdown();

      // drain() の microtask を先に流す (server.close は呼ばれるがコールバックは来ない)
      await vi.advanceTimersByTimeAsync(0);
      expect(exit).not.toHaveBeenCalled();
      expect(server.closeAllConnectionsCalls).toBe(0);

      // タイムアウトちょうど手前ではまだ強制終了しない
      await vi.advanceTimersByTimeAsync(4_999);
      expect(exit).not.toHaveBeenCalled();

      // タイムアウトに到達すると、既存接続を強制的に閉じたうえで exit する
      await vi.advanceTimersByTimeAsync(1);
      expect(onTimeout).toHaveBeenCalledTimes(1);
      expect(server.closeAllConnectionsCalls).toBe(1);
      expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores a second SIGTERM-style call while already shutting down', async () => {
    vi.useFakeTimers();
    try {
      const drain = vi.fn(async () => {});
      const server = createFakeServer();
      const exit = vi.fn();

      const shutdown = createGracefulShutdown({ drain, server, exit, timeoutMs: 1_000 });

      shutdown();
      shutdown();
      shutdown();

      await vi.advanceTimersByTimeAsync(0);

      expect(drain).toHaveBeenCalledTimes(1);
      expect(exit).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports drain errors via onError but still lets the close/timeout path finish', async () => {
    vi.useFakeTimers();
    try {
      const failure = new Error('stopWatcher exploded');
      const drain = vi.fn(async () => {
        throw failure;
      });
      const server = createFakeServer();
      const exit = vi.fn();
      const onError = vi.fn();

      const shutdown = createGracefulShutdown({ drain, server, exit, onError, timeoutMs: 1_000 });
      shutdown();

      await vi.advanceTimersByTimeAsync(0);

      expect(onError).toHaveBeenCalledExactlyOnceWith(failure);
      expect(server.closeAllConnectionsCalls).toBe(0);
      expect(exit).toHaveBeenCalledExactlyOnceWith(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses DEFAULT_SHUTDOWN_TIMEOUT_MS when timeoutMs is not provided', async () => {
    vi.useFakeTimers();
    try {
      const drain = vi.fn(async () => {});
      const server = createFakeServer({ close: () => {} });
      const exit = vi.fn();

      const shutdown = createGracefulShutdown({ drain, server, exit });
      shutdown();

      await vi.advanceTimersByTimeAsync(0);
      expect(exit).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(DEFAULT_SHUTDOWN_TIMEOUT_MS - 1);
      expect(exit).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
