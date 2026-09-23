import { describe, expect, it, vi } from 'vitest';
import { wireShutdown, type WireShutdownDeps } from './wire-shutdown.js';

function createDeps(overrides: Partial<WireShutdownDeps> = {}): WireShutdownDeps {
  return {
    runStore: { cancelAllAndWait: vi.fn(async () => {}) },
    watchHandle: { stop: vi.fn(async () => {}) },
    tunnelService: { shutdown: vi.fn(async () => ({ kind: 'off' as const })) },
    cache: { close: vi.fn() },
    chatRepositories: [{ close: vi.fn() }],
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
  it('clears every interval timer, stops the reclaim scheduler, then drains runStore/tunnel/watch/cache/chat before exiting', async () => {
    vi.useFakeTimers();
    try {
      const order: string[] = [];
      const deps = createDeps({
        runStore: {
          cancelAllAndWait: vi.fn(async () => {
            order.push('runStore.cancelAllAndWait');
          }),
        },
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
        chatRepositories: [
          {
            close: vi.fn(() => {
              order.push('chatRepositories[0].close');
            }),
          },
        ],
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

      // clearInterval そのものを order へ記録できるよう、どのタイマーが渡されたかで
      // ラベルを引けるマップを先に作っておく (5本とも spy 一本で区別する)。
      const timerLabels = new Map<unknown, string>([
        [deps.refreshIntervalTimer, 'clearInterval(refresh)'],
        [deps.sessionIntervalTimer, 'clearInterval(session)'],
        [deps.transcriptIntervalTimer, 'clearInterval(transcript)'],
        [deps.cfdSnapshotIntervalTimer, 'clearInterval(cfdSnapshot)'],
        [deps.aiQuotaAlertIntervalTimer, 'clearInterval(aiQuotaAlert)'],
      ]);
      const clearIntervalSpy = vi.spyOn(global, 'clearInterval').mockImplementation((timer) => {
        order.push(timerLabels.get(timer) ?? 'clearInterval(unknown)');
      });

      const { shutdownForSignal } = wireShutdown(deps);
      shutdownForSignal();

      await vi.advanceTimersByTimeAsync(0);

      // drain 内部の順序 (application/board/shutdown-drain.ts 側の契約): runStore →
      // tunnelService → watchHandle → cache → chatRepositories。タイマー停止と
      // reclaimScheduler.stop() はその手前で既に呼ばれている。
      expect(order).toEqual([
        'clearInterval(refresh)',
        'clearInterval(session)',
        'clearInterval(transcript)',
        'clearInterval(cfdSnapshot)',
        'clearInterval(aiQuotaAlert)',
        'reclaimScheduler.stop',
        'runStore.cancelAllAndWait',
        'tunnelService.shutdown',
        'watchHandle.stop',
        'cache.close',
        'chatRepositories[0].close',
        'server.close',
      ]);

      expect(deps.exit).toHaveBeenCalledExactlyOnceWith(0);
      clearIntervalSpy.mockRestore();
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
      clearIntervalSpy.mockRestore();
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
      // このテストは vi.useFakeTimers() を使わないため、createDeps() が張った
      // 5本の実タイマーが残ったままだと vitest プロセスがハングしかねない。
      clearInterval(deps.refreshIntervalTimer);
      if (deps.sessionIntervalTimer !== null) clearInterval(deps.sessionIntervalTimer);
      if (deps.transcriptIntervalTimer !== undefined) clearInterval(deps.transcriptIntervalTimer);
      if (deps.cfdSnapshotIntervalTimer !== undefined) clearInterval(deps.cfdSnapshotIntervalTimer);
      if (deps.aiQuotaAlertIntervalTimer !== undefined) clearInterval(deps.aiQuotaAlertIntervalTimer);
    }
  });
});
