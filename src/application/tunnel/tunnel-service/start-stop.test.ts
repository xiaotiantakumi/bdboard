import { describe, expect, it, vi } from 'vitest';
import { createInMemoryTunnelInterruptionStore } from '../../ports/tunnel-interruption-store-fakes.js';
import type { TunnelProcess, TunnelStartResult } from '../../ports/tunnel.js';
import type { TunnelAccessService } from '../tunnel-access.js';
import { createTunnelServiceState } from './state.js';
import { shutdown, start, startInternal, stop, stopInternal } from './start-stop.js';
import type { TunnelServiceDeps, TunnelState } from './types.js';

// Placeholder-shaped on purpose: adjacent username/password fixture values are what
// GitGuardian's Username Password detector fires on by pattern (see CLAUDE.md).
const USERNAME = 'example-user';
const TUNNEL_URL = 'https://abc.trycloudflare.com';
const NOW = new Date('2026-08-14T12:00:00.000Z');

function createFakeTunnel(
  overrides: {
    readonly start?: () => Promise<TunnelStartResult>;
    readonly stop?: () => Promise<void>;
    readonly isAvailable?: () => Promise<boolean>;
  } = {},
): {
  readonly tunnel: TunnelProcess;
  readonly startMock: ReturnType<typeof vi.fn>;
  readonly stopMock: ReturnType<typeof vi.fn>;
} {
  const startMock = vi.fn(
    overrides.start ?? (async (): Promise<TunnelStartResult> => ({ url: TUNNEL_URL })),
  );
  const stopMock = vi.fn(overrides.stop ?? (async (): Promise<void> => {}));
  const isAvailableMock = vi.fn(overrides.isAvailable ?? (async (): Promise<boolean> => true));
  return {
    tunnel: { start: startMock, stop: stopMock, isAvailable: isAvailableMock },
    startMock,
    stopMock,
  };
}

function createDeps(
  tunnel: TunnelProcess,
  overrides: {
    readonly access?: TunnelAccessService;
    readonly interruptions?: ReturnType<typeof createInMemoryTunnelInterruptionStore>;
  } = {},
): TunnelServiceDeps {
  return {
    tunnel,
    now: () => NOW,
    username: USERNAME,
    generatePassword: () => 'generated-pass-phrase',
    ...(overrides.access !== undefined ? { access: overrides.access } : {}),
    ...(overrides.interruptions !== undefined ? { interruptions: overrides.interruptions } : {}),
  };
}

function onState(): TunnelState {
  return {
    kind: 'on',
    url: TUNNEL_URL,
    username: USERNAME,
    password: 'example-password',
    startedAt: NOW,
  };
}

/**
 * bdboard-ksvs: state/writeAllowed/availability/operationGeneration/startInFlight/
 * stopInFlight を1つの TunnelServiceState コンテナへ出したことで、start/stop/shutdown
 * (このファイル) と probe/availability (./availability.ts) が、モジュールを跨いで
 * 同じコンテナ・インスタンスを読み書きするようになった。ここでは
 * createTunnelService() を経由せず、切り出した関数群を直接呼んで、分割前と同じ
 * 競合時の挙動 (in-flight の重複排除・operationGeneration による古い操作の破棄・
 * shutdown 中の中断記録・probe 失敗時の状態遷移) をコンテナ越しに検証する。
 * (公開 API (createTunnelService) 経由の同等シナリオは既存の tunnel-service.test.ts
 * でカバーされている。こちらはモジュール分割そのものが壊れていないかの単体テスト。)
 */
describe('tunnel-service/start-stop.ts (bdboard-ksvs state-container split)', () => {
  describe('stopInternal', () => {
    it('leaves an unavailable state untouched and skips tunnel.stop()', async () => {
      const { tunnel, stopMock } = createFakeTunnel();
      const ctx = createTunnelServiceState();
      ctx.state = { kind: 'unavailable' };

      const result = await stopInternal(ctx, createDeps(tunnel));

      expect(stopMock).not.toHaveBeenCalled();
      expect(result).toEqual({ kind: 'unavailable' });
    });

    it('discards a stale captured generation without ending the tunnel-access session', async () => {
      const { tunnel } = createFakeTunnel();
      const access = {
        beginTunnelSession: vi.fn(),
        endTunnelSession: vi.fn(),
        issueToken: vi.fn(() => null),
        consumeToken: vi.fn(() => null),
        isValidSession: vi.fn(() => false),
      } satisfies TunnelAccessService;
      const ctx = createTunnelServiceState();
      ctx.state = onState();
      ctx.writeAllowed = true;
      ctx.operationGeneration = 5;

      // capturedGeneration (4) no longer matches ctx.operationGeneration (5), as if a
      // newer start()/stop() had raced ahead while this stopInternal() was awaiting
      // tunnel.stop().
      const result = await stopInternal(ctx, createDeps(tunnel, { access }), 4);

      expect(result).toBe(ctx.state);
      expect(ctx.state).toEqual(onState());
      expect(ctx.writeAllowed).toBe(true);
      expect(access.endTunnelSession).not.toHaveBeenCalled();
    });
  });

  describe('start() vs stop() racing across the shared container', () => {
    it('lets stop() win: a slower in-flight start does not clobber the newer off state', async () => {
      let resolveTunnelStart: (result: TunnelStartResult) => void = () => {};
      const { tunnel, startMock } = createFakeTunnel({
        start: () =>
          new Promise<TunnelStartResult>((resolve) => {
            resolveTunnelStart = resolve;
          }),
      });
      const deps = createDeps(tunnel);
      const ctx = createTunnelServiceState();

      const startPromise = start(ctx, deps);
      await vi.waitFor(() => expect(ctx.state).toEqual({ kind: 'starting' }));

      const stopResult = await stop(ctx, deps);
      expect(stopResult).toEqual({ kind: 'off' });

      resolveTunnelStart({ url: TUNNEL_URL });
      const startResult = await startPromise;

      expect(startMock).toHaveBeenCalledTimes(1);
      expect(startResult).toEqual({ kind: 'off' });
      expect(ctx.state).toEqual({ kind: 'off' });
    });

    it('start() joins an in-flight stop() before probing again', async () => {
      let resolveTunnelStop: () => void = () => {};
      const { tunnel, startMock, stopMock } = createFakeTunnel({
        stop: () =>
          new Promise<void>((resolve) => {
            resolveTunnelStop = resolve;
          }),
      });
      const deps = createDeps(tunnel);
      const ctx = createTunnelServiceState();

      const stopPromise = stop(ctx, deps);
      await vi.waitFor(() => expect(stopMock).toHaveBeenCalledTimes(1));

      const startPromise = start(ctx, deps);
      // start() must await the in-flight stop() before touching the tunnel process.
      expect(startMock).not.toHaveBeenCalled();

      resolveTunnelStop();
      await stopPromise;
      const startResult = await startPromise;

      expect(startMock).toHaveBeenCalledTimes(1);
      expect(startResult.kind).toBe('on');
      expect(ctx.state.kind).toBe('on');
    });
  });

  describe('shutdown', () => {
    it('marks an interruption only when the tunnel was on, then transitions off', async () => {
      const { tunnel } = createFakeTunnel();
      const interruptions = createInMemoryTunnelInterruptionStore();
      const ctx = createTunnelServiceState();
      ctx.state = onState();

      const result = await shutdown(ctx, createDeps(tunnel, { interruptions }));

      expect(interruptions.interruptedAt).toEqual(NOW);
      expect(result).toEqual({ kind: 'off' });
    });

    it('does not mark an interruption when the tunnel was already off', async () => {
      const { tunnel } = createFakeTunnel();
      const interruptions = createInMemoryTunnelInterruptionStore();
      const ctx = createTunnelServiceState();

      await shutdown(ctx, createDeps(tunnel, { interruptions }));

      expect(interruptions.interruptedAt).toBeNull();
    });

    it('shares the stopInFlight slot with a concurrent stop(): only one tunnel.stop() runs', async () => {
      const { tunnel, stopMock } = createFakeTunnel();
      const ctx = createTunnelServiceState();
      ctx.state = onState();
      const deps = createDeps(tunnel);

      // Both calls read ctx.stopInFlight in the same synchronous tick (before either
      // IIFE's first await runs), so stop() must see shutdown()'s in-flight slot and
      // join it rather than starting a second stopInternal().
      const shutdownPromise = shutdown(ctx, deps);
      const stopPromise = stop(ctx, deps);

      const [shutdownResult, stopResult] = await Promise.all([shutdownPromise, stopPromise]);

      expect(shutdownResult).toEqual(stopResult);
      expect(stopMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('startInternal', () => {
    it('sets state to unavailable and never touches the tunnel process when the probe fails', async () => {
      const { tunnel, startMock } = createFakeTunnel({ isAvailable: async () => false });
      const ctx = createTunnelServiceState();
      const deps = createDeps(tunnel);

      const result = await startInternal(ctx, deps, undefined, ctx.operationGeneration);

      expect(result).toEqual({ kind: 'unavailable' });
      expect(ctx.state).toEqual({ kind: 'unavailable' });
      expect(startMock).not.toHaveBeenCalled();
    });

    it('sets state to unavailable when the probe throws (probe failure)', async () => {
      const { tunnel, startMock } = createFakeTunnel({
        isAvailable: async () => {
          throw new Error('cloudflared not on PATH');
        },
      });
      const ctx = createTunnelServiceState();
      const deps = createDeps(tunnel);

      const result = await startInternal(ctx, deps, undefined, ctx.operationGeneration);

      expect(result).toEqual({ kind: 'unavailable' });
      expect(startMock).not.toHaveBeenCalled();
    });
  });
});
