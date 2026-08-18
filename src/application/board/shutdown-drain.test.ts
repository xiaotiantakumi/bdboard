import { describe, expect, it, vi } from 'vitest';
import type { BoardCache } from '../ports/board-cache.js';
import type { ProjectWatchHandle } from '../ports/project-watcher.js';
import { createInMemoryTunnelInterruptionStore } from '../ports/tunnel-interruption-store-fakes.js';
import type { TunnelProcess, TunnelStartResult } from '../ports/tunnel.js';
import type { TunnelService, TunnelState } from '../tunnel/tunnel-service.js';
import { createTunnelService } from '../tunnel/tunnel-service.js';
import { createShutdownDrain } from './shutdown-drain.js';

const TUNNEL_URL = 'https://abc.trycloudflare.com';
const FIXED_NOW = new Date('2026-08-15T03:00:00.000Z');

function createFakeTunnel(
  overrides: Partial<TunnelProcess> = {},
): TunnelProcess & {
  readonly triggerUnexpectedExit: () => void;
} {
  const unexpectedExitListeners: Array<() => void> = [];

  return {
    start:
      overrides.start ??
      (async (): Promise<TunnelStartResult> => ({ url: TUNNEL_URL })),
    stop: overrides.stop ?? (async (): Promise<void> => {}),
    isAvailable: overrides.isAvailable ?? (async (): Promise<boolean> => true),
    onUnexpectedExit:
      overrides.onUnexpectedExit ??
      ((listener: () => void) => {
        unexpectedExitListeners.push(listener);
      }),
    triggerUnexpectedExit: () => {
      for (const listener of unexpectedExitListeners) {
        listener();
      }
    },
  };
}

function fakeDeps(overrides?: {
  watchStop?: () => Promise<void>;
  tunnelShutdown?: () => Promise<TunnelState>;
  tunnelStop?: () => Promise<TunnelState>;
  cacheClose?: () => void;
}): {
  watchHandle: Pick<ProjectWatchHandle, 'stop'>;
  tunnelService: Pick<TunnelService, 'shutdown' | 'stop'>;
  cache: Pick<BoardCache, 'close'>;
  calls: string[];
} {
  const calls: string[] = [];
  const watchStop =
    overrides?.watchStop != null
      ? vi.fn(async () => {
          calls.push('watchHandle.stop');
          return await overrides.watchStop!();
        })
      : vi.fn(async () => {
          calls.push('watchHandle.stop');
        });
  const tunnelShutdown =
    overrides?.tunnelShutdown != null
      ? vi.fn(async () => {
          calls.push('tunnelService.shutdown');
          return await overrides.tunnelShutdown!();
        })
      : vi.fn(async () => {
          calls.push('tunnelService.shutdown');
          return { kind: 'off' as const };
        });
  const tunnelStop =
    overrides?.tunnelStop ??
    vi.fn(async () => {
      calls.push('tunnelService.stop');
      return { kind: 'off' as const };
    });
  const cacheClose =
    overrides?.cacheClose != null
      ? vi.fn(() => {
          calls.push('cache.close');
          return overrides.cacheClose!();
        })
      : vi.fn(() => {
          calls.push('cache.close');
        });

  return {
    calls,
    watchHandle: { stop: watchStop },
    tunnelService: { shutdown: tunnelShutdown, stop: tunnelStop },
    cache: { close: cacheClose },
  };
}

describe('createShutdownDrain', () => {
  it('calls tunnelService.shutdown() not stop() when draining with an active tunnel', async () => {
    const { watchHandle, tunnelService, cache, calls } = fakeDeps();
    const drain = createShutdownDrain({ watchHandle, tunnelService, cache });

    await drain();

    expect(tunnelService.shutdown).toHaveBeenCalledOnce();
    expect(tunnelService.stop).not.toHaveBeenCalled();
    expect(calls).toEqual([
      'tunnelService.shutdown',
      'watchHandle.stop',
      'cache.close',
    ]);
  });

  it('runs tunnelService.shutdown, watchHandle.stop, then cache.close in order', async () => {
    const { watchHandle, tunnelService, cache, calls } = fakeDeps();
    const drain = createShutdownDrain({ watchHandle, tunnelService, cache });

    await drain();

    expect(calls).toEqual([
      'tunnelService.shutdown',
      'watchHandle.stop',
      'cache.close',
    ]);
  });

  it('still runs tunnelService.shutdown and cache.close when watchHandle.stop() rejects, then rejects with AggregateError', async () => {
    const watchError = new Error('watch stop failed');
    const { watchHandle, tunnelService, cache, calls } = fakeDeps({
      watchStop: vi.fn(async () => {
        throw watchError;
      }),
    });
    const drain = createShutdownDrain({ watchHandle, tunnelService, cache });

    try {
      await drain();
      expect.fail('drain() should reject');
    } catch (err) {
      expect(err).toBeInstanceOf(AggregateError);
      const aggregate = err as AggregateError;
      expect(aggregate.errors).toHaveLength(1);
      expect(aggregate.errors[0]).toBe(watchError);
      expect(aggregate.message).toContain('watchHandle.stop: watch stop failed');
    }

    expect(tunnelService.shutdown).toHaveBeenCalledOnce();
    expect(cache.close).toHaveBeenCalledOnce();
    expect(calls).toEqual([
      'tunnelService.shutdown',
      'watchHandle.stop',
      'cache.close',
    ]);
  });

  it('still runs cache.close when tunnelService.shutdown() rejects, then rejects with AggregateError', async () => {
    const tunnelError = new Error('tunnel shutdown failed');
    const { watchHandle, tunnelService, cache, calls } = fakeDeps({
      tunnelShutdown: vi.fn(async () => {
        throw tunnelError;
      }),
    });
    const drain = createShutdownDrain({ watchHandle, tunnelService, cache });

    try {
      await drain();
      expect.fail('drain() should reject');
    } catch (err) {
      expect(err).toBeInstanceOf(AggregateError);
      const aggregate = err as AggregateError;
      expect(aggregate.errors).toHaveLength(1);
      expect(aggregate.errors[0]).toBe(tunnelError);
      expect(aggregate.message).toContain(
        'tunnelService.shutdown: tunnel shutdown failed',
      );
    }

    expect(cache.close).toHaveBeenCalledOnce();
    expect(calls).toEqual([
      'tunnelService.shutdown',
      'watchHandle.stop',
      'cache.close',
    ]);
  });

  it('rejects with AggregateError containing all three errors when every step fails', async () => {
    const watchError = new Error('watch stop failed');
    const tunnelError = new Error('tunnel shutdown failed');
    const cacheError = new Error('cache close failed');
    const { watchHandle, tunnelService, cache, calls } = fakeDeps({
      watchStop: vi.fn(async () => {
        throw watchError;
      }),
      tunnelShutdown: vi.fn(async () => {
        throw tunnelError;
      }),
      cacheClose: vi.fn(() => {
        throw cacheError;
      }),
    });
    const drain = createShutdownDrain({ watchHandle, tunnelService, cache });

    try {
      await drain();
      expect.fail('drain() should reject');
    } catch (err) {
      expect(err).toBeInstanceOf(AggregateError);
      const aggregate = err as AggregateError;
      expect(aggregate.errors).toHaveLength(3);
      expect(aggregate.errors[0]).toBe(tunnelError);
      expect(aggregate.errors[1]).toBe(watchError);
      expect(aggregate.errors[2]).toBe(cacheError);
      // onError は err.message しか出さないので、ステップ名だけでなく理由も message に
      // 畳み込まれていること (bdboard-crw)。
      expect(aggregate.message).toContain('watchHandle.stop: watch stop failed');
      expect(aggregate.message).toContain(
        'tunnelService.shutdown: tunnel shutdown failed',
      );
      expect(aggregate.message).toContain('cache.close: cache close failed');
    }

    expect(calls).toEqual([
      'tunnelService.shutdown',
      'watchHandle.stop',
      'cache.close',
    ]);
  });

  it('rejects with AggregateError when cache.close() throws, after watchHandle.stop and tunnelService.shutdown succeed', async () => {
    const cacheError = new Error('cache close failed');
    const { watchHandle, tunnelService, cache, calls } = fakeDeps({
      cacheClose: vi.fn(() => {
        throw cacheError;
      }),
    });
    const drain = createShutdownDrain({ watchHandle, tunnelService, cache });

    try {
      await drain();
      expect.fail('drain() should reject');
    } catch (err) {
      expect(err).toBeInstanceOf(AggregateError);
      const aggregate = err as AggregateError;
      expect(aggregate.errors).toHaveLength(1);
      expect(aggregate.errors[0]).toBe(cacheError);
      expect(aggregate.message).toContain('cache.close: cache close failed');
    }

    expect(tunnelService.shutdown).toHaveBeenCalledOnce();
    expect(calls).toEqual([
      'tunnelService.shutdown',
      'watchHandle.stop',
      'cache.close',
    ]);
  });

  it('wraps a non-Error rejection so AggregateError.errors stays Error[]', async () => {
    const { watchHandle, tunnelService, cache, calls } = fakeDeps({
      watchStop: vi.fn(async () => {
        // 意図的に Error 以外を投げる (record() のラップ経路を通すため)。
        throw 'watch stop blew up';
      }),
    });
    const drain = createShutdownDrain({ watchHandle, tunnelService, cache });

    try {
      await drain();
      expect.fail('drain() should reject');
    } catch (err) {
      expect(err).toBeInstanceOf(AggregateError);
      const aggregate = err as AggregateError;
      expect(aggregate.errors).toHaveLength(1);
      expect(aggregate.errors[0]).toBeInstanceOf(Error);
      expect((aggregate.errors[0] as Error).message).toBe('watch stop blew up');
      expect(aggregate.message).toContain('watchHandle.stop: watch stop blew up');
    }

    expect(calls).toEqual([
      'tunnelService.shutdown',
      'watchHandle.stop',
      'cache.close',
    ]);
  });

  it('records the interruption marker even if the tunnel process exits unexpectedly while watchHandle.stop() is still pending (bdboard-bch race regression)', async () => {
    const fakeTunnel = createFakeTunnel();
    const interruptions = createInMemoryTunnelInterruptionStore();
    const tunnelService = createTunnelService({
      tunnel: fakeTunnel,
      now: () => FIXED_NOW,
      username: 'example-user',
      generatePassword: () => 'x',
      interruptions,
    });

    await tunnelService.start({ password: 'example-password' });

    let resolveWatchStop: (() => void) | undefined;
    const watchStopPending = new Promise<void>((resolve) => {
      resolveWatchStop = resolve;
    });
    const watchHandle: Pick<ProjectWatchHandle, 'stop'> = {
      stop: vi.fn(async () => watchStopPending),
    };
    const cache: Pick<BoardCache, 'close'> = { close: vi.fn() };

    const drain = createShutdownDrain({ watchHandle, tunnelService, cache });
    const drainPromise = drain();

    fakeTunnel.triggerUnexpectedExit();
    resolveWatchStop!();
    await drainPromise;

    expect(interruptions.read()).toEqual(FIXED_NOW);
  });
});
