import { describe, expect, it, vi } from 'vitest';
import { wireShutdown, type WireShutdownDeps } from './wire-shutdown.js';

function createDeps(overrides: Partial<WireShutdownDeps> = {}): WireShutdownDeps {
  return {
    watchHandle: { stop: vi.fn(async () => {}) },
    tunnelService: { shutdown: vi.fn(async () => ({ kind: 'off' as const })) },
    cache: { close: vi.fn() },
    server: {
      close: (callback) => callback(),
      closeAllConnections: vi.fn(),
    },
    shutdownTimeoutMs: 5_000,
    refreshIntervalTimer: setInterval(() => {}, 1_000_000),
    sessionIntervalTimer: setInterval(() => {}, 1_000_000),
    transcriptIntervalTimer: setInterval(() => {}, 1_000_000),
    cfdSnapshotIntervalTimer: setInterval(() => {}, 1_000_000),
    aiQuotaAlertIntervalTimer: setInterval(() => {}, 1_000_000),
    reclaimScheduler: { stop: vi.fn() },
    exit: vi.fn(),
    log: { error: vi.fn() },
    registerSignalHandlers: false,
    ...overrides,
  };
}

describe('wireShutdown (bdboard-sso1.86 move only, main.ts の shutdownForSignal を切り出したもの)', () => {
  it('clears every interval timer and stops the reclaim scheduler before draining/exiting', async () => {
    vi.useFakeTimers();
    try {
      const order: string[] = [];
      const deps = createDeps({
        tunnelService: {
          shutdown: vi.fn(async () => {
            order.push('tunnelService.shutdown');
            return { kind: 'off' as const };
          }),
        },
        watchHandle: {
          stop: vi.fn(async () => {
            order.push('watchHandle.stop');
          }),
        },
        cache: {
          close: vi.fn(() => {
            order.push('cache.close');
          }),
        },
        reclaimScheduler: {
          stop: vi.fn(() => {
            order.push('reclaimScheduler.stop');
          }),
        },
        server: {
          close: (callback) => {
            order.push('server.close');
            callback();
          },
          closeAllConnections: vi.fn(),
        },
      });

      const clearIntervalSpy = vi.spyOn(global, 'clearInterval');

      const { shutdownForSignal } = wireShutdown(deps);
      shutdownForSignal();

      // reclaimScheduler.stop() は同期区間 (drain 起動の前) で呼ばれる。
      expect(order[0]).toBe('reclaimScheduler.stop');

      await vi.advanceTimersByTimeAsync(0);

      // drain 内部の順序 (application/board/shutdown-drain.ts 側の契約): tunnelService
      // → watchHandle → cache。reclaimScheduler.stop() はその手前で既に呼ばれている。
      expect(order).toEqual([
        'reclaimScheduler.stop',
        'tunnelService.shutdown',
        'watchHandle.stop',
        'cache.close',
        'server.close',
      ]);

      expect(clearIntervalSpy).toHaveBeenCalledWith(deps.refreshIntervalTimer);
      expect(clearIntervalSpy).toHaveBeenCalledWith(deps.sessionIntervalTimer);
      expect(clearIntervalSpy).toHaveBeenCalledWith(deps.transcriptIntervalTimer);
      expect(clearIntervalSpy).toHaveBeenCalledWith(deps.cfdSnapshotIntervalTimer);
      expect(clearIntervalSpy).toHaveBeenCalledWith(deps.aiQuotaAlertIntervalTimer);

      expect(deps.exit).toHaveBeenCalledExactlyOnceWith(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('tolerates undefined/null optional timers (transcript/CFD/ai-quota disabled, session-discovery unsupported)', async () => {
    vi.useFakeTimers();
    try {
      const deps = createDeps({
        sessionIntervalTimer: null,
        transcriptIntervalTimer: undefined,
        cfdSnapshotIntervalTimer: undefined,
        aiQuotaAlertIntervalTimer: undefined,
      });
      const clearIntervalSpy = vi.spyOn(global, 'clearInterval');

      const { shutdownForSignal } = wireShutdown(deps);
      expect(() => shutdownForSignal()).not.toThrow();
      await vi.advanceTimersByTimeAsync(0);

      // refreshIntervalTimer は常に定義されるので必ず clearInterval される。
      expect(clearIntervalSpy).toHaveBeenCalledWith(deps.refreshIntervalTimer);
      expect(deps.exit).toHaveBeenCalledExactlyOnceWith(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores a second shutdownForSignal call (double SIGTERM guard, delegated to createGracefulShutdown)', async () => {
    vi.useFakeTimers();
    try {
      const deps = createDeps();
      const { shutdownForSignal } = wireShutdown(deps);

      shutdownForSignal();
      shutdownForSignal();
      await vi.advanceTimersByTimeAsync(0);

      expect(deps.exit).toHaveBeenCalledTimes(1);
      expect(deps.reclaimScheduler.stop).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('registers shutdownForSignal on SIGINT and SIGTERM when registerSignalHandlers is not false (default)', () => {
    const onSpy = vi.spyOn(process, 'on');
    const deps = createDeps({ registerSignalHandlers: undefined });
    const { shutdownForSignal } = wireShutdown(deps);
    try {
      expect(onSpy).toHaveBeenCalledWith('SIGINT', shutdownForSignal);
      expect(onSpy).toHaveBeenCalledWith('SIGTERM', shutdownForSignal);
    } finally {
      // 実プロセスにハンドラが残らないよう、登録した参照をそのまま外す。
      process.off('SIGINT', shutdownForSignal);
      process.off('SIGTERM', shutdownForSignal);
      onSpy.mockRestore();
    }
  });
});
