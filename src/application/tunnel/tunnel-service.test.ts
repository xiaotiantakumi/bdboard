import { describe, expect, it, vi } from 'vitest';
import { createInMemoryTunnelInterruptionStore } from '../ports/tunnel-interruption-store-fakes.js';
import type { TunnelInterruptionStore } from '../ports/tunnel-interruption-store.js';
import type { TunnelProcess, TunnelStartResult } from '../ports/tunnel.js';
import type { TunnelAccessService } from './tunnel-access.js';
import {
  TUNNEL_AVAILABILITY_RECHECK_MS,
  createTunnelService,
} from './tunnel-service.js';

// Placeholder-shaped on purpose: adjacent username/password fixture values
// are what GitGuardian's Username Password detector fires on by pattern,
// regardless of whether the value is a real secret (see CLAUDE.md).
const USERNAME = 'example-user';
const TUNNEL_URL = 'https://abc.trycloudflare.com';

function createFakeTunnel(
  overrides: Partial<TunnelProcess> = {},
): TunnelProcess & {
  readonly startMock: ReturnType<typeof vi.fn>;
  readonly stopMock: ReturnType<typeof vi.fn>;
  readonly isAvailableMock: ReturnType<typeof vi.fn>;
  /** テストから直接、登録済みonUnexpectedExitリスナーを発火させる */
  triggerUnexpectedExit: () => void;
} {
  const startMock = vi.fn<() => Promise<TunnelStartResult>>(async () => ({
    url: TUNNEL_URL,
  }));
  const stopMock = vi.fn<() => Promise<void>>(async () => {});
  const isAvailableMock = vi.fn<() => Promise<boolean>>(async () => true);
  const unexpectedExitListeners: Array<() => void> = [];

  return {
    start: overrides.start ?? startMock,
    stop: overrides.stop ?? stopMock,
    isAvailable: overrides.isAvailable ?? isAvailableMock,
    onUnexpectedExit:
      overrides.onUnexpectedExit ??
      ((listener: () => void) => {
        unexpectedExitListeners.push(listener);
      }),
    startMock,
    stopMock,
    isAvailableMock,
    triggerUnexpectedExit: () => {
      for (const listener of unexpectedExitListeners) {
        listener();
      }
    },
  };
}

function createService(
  tunnel: TunnelProcess,
  overrides: Partial<{
    now: () => Date;
    username: string;
    generatePassword: () => string;
    access: TunnelAccessService;
    interruptions: TunnelInterruptionStore;
  }> = {},
) {
  const now = overrides.now ?? ((): Date => new Date('2026-08-14T12:00:00.000Z'));
  const generatePassword =
    overrides.generatePassword ?? ((): string => 'generated-pass-phrase');

  return createTunnelService({
    tunnel,
    now,
    username: overrides.username ?? USERNAME,
    generatePassword,
    ...(overrides.access !== undefined ? { access: overrides.access } : {}),
    ...(overrides.interruptions !== undefined
      ? { interruptions: overrides.interruptions }
      : {}),
  });
}

describe('createTunnelService', () => {
  it('does not start when cloudflared is unavailable', async () => {
    const tunnel = createFakeTunnel({
      isAvailable: async () => false,
    });
    const service = createService(tunnel);

    const result = await service.start();

    expect(result).toEqual({ kind: 'unavailable' });
    expect(tunnel.startMock).not.toHaveBeenCalled();
    expect(service.getState()).toEqual({ kind: 'unavailable' });
  });

  it('transitions to on with url and credentials on successful start', async () => {
    const tunnel = createFakeTunnel();
    const service = createService(tunnel, {
      generatePassword: () => 'example-password',
    });

    const result = await service.start();

    expect(result.kind).toBe('on');
    if (result.kind === 'on') {
      expect(result.url).toBe(TUNNEL_URL);
      expect(result.username).toBe(USERNAME);
      expect(result.password).toBe('example-password');
      expect(result.startedAt).toEqual(new Date('2026-08-14T12:00:00.000Z'));
    }

    expect(service.getCredentials()).toEqual({
      username: USERNAME,
      password: 'example-password',
    });
  });

  it('uses explicit password when provided', async () => {
    const tunnel = createFakeTunnel();
    const generatePassword = vi.fn(() => 'should-not-be-used');
    const service = createService(tunnel, { generatePassword });

    await service.start({ password: 'custom-password-123' });

    expect(generatePassword).not.toHaveBeenCalled();
    expect(service.getCredentials()?.password).toBe('custom-password-123');
  });

  it('uses generatePassword when password is not provided', async () => {
    const tunnel = createFakeTunnel();
    const generatePassword = vi.fn(() => 'auto-generated');
    const service = createService(tunnel, { generatePassword });

    await service.start();

    expect(generatePassword).toHaveBeenCalledOnce();
    expect(service.getCredentials()?.password).toBe('auto-generated');
  });

  it('calls stop once before restarting when already on', async () => {
    const tunnel = createFakeTunnel();
    const service = createService(tunnel);

    await service.start({ password: 'first-password' });
    await service.start({ password: 'second-password' });

    expect(tunnel.stopMock).toHaveBeenCalledTimes(1);
    expect(service.getCredentials()?.password).toBe('second-password');
  });

  it('enters error state when start fails and attempts cleanup', async () => {
    const tunnel = createFakeTunnel({
      start: async () => {
        throw new Error('tunnel spawn failed');
      },
    });
    const service = createService(tunnel);

    const result = await service.start({ password: 'secret-password-99' });

    expect(result).toEqual({ kind: 'error', message: 'tunnel spawn failed' });
    expect(tunnel.stopMock).toHaveBeenCalled();
    expect(service.getCredentials()).toBeNull();
    expect(JSON.stringify(result)).not.toContain('secret-password-99');
  });

  it('stop transitions to off and clears credentials', async () => {
    const tunnel = createFakeTunnel();
    const service = createService(tunnel);

    await service.start({ password: 'temp-password' });
    const result = await service.stop();

    expect(result).toEqual({ kind: 'off' });
    expect(tunnel.stopMock).toHaveBeenCalled();
    expect(service.getCredentials()).toBeNull();
  });

  it('stop keeps unavailable state when unavailable', async () => {
    const tunnel = createFakeTunnel({
      isAvailable: async () => false,
    });
    const service = createService(tunnel);

    await service.start();
    const result = await service.stop();

    expect(result).toEqual({ kind: 'unavailable' });
  });

  it('transitions on -> error when the tunnel process exits unexpectedly', async () => {
    const tunnel = createFakeTunnel();
    const service = createService(tunnel);

    await service.start({ password: 'p' });
    expect(service.getState().kind).toBe('on');

    tunnel.triggerUnexpectedExit();

    expect(service.getState()).toEqual({
      kind: 'error',
      message:
        '開発サーバーの再起動によりトンネルが切断されました。再度ONにしてください。',
    });
    expect(service.getCredentials()).toBeNull();
  });

  it('ignores an unexpected-exit notification while not in the on state', async () => {
    const tunnel = createFakeTunnel();
    const service = createService(tunnel);

    // never started: state is still 'off'
    tunnel.triggerUnexpectedExit();

    expect(service.getState()).toEqual({ kind: 'off' });
  });

  it('does not fire error state for onUnexpectedExit after a deliberate stop()', async () => {
    const tunnel = createFakeTunnel();
    const service = createService(tunnel);

    await service.start({ password: 'p' });
    await service.stop();
    expect(service.getState()).toEqual({ kind: 'off' });

    // Simulates the underlying process's close event arriving after stop() already
    // transitioned state to 'off' (tunnel.stop() itself is responsible for not
    // calling the listener in the real cloudflared-tunnel.ts implementation; this
    // asserts the service layer is also defensive about it).
    tunnel.triggerUnexpectedExit();

    expect(service.getState()).toEqual({ kind: 'off' });
  });

  it('serializes concurrent start calls', async () => {
    let startCallCount = 0;
    let resolveStart: ((value: TunnelStartResult) => void) | undefined;
    const pendingStart = new Promise<TunnelStartResult>((resolve) => {
      resolveStart = resolve;
    });

    const tunnel = createFakeTunnel({
      start: async () => {
        startCallCount += 1;
        return pendingStart;
      },
    });
    const service = createService(tunnel);

    const first = service.start({ password: 'concurrent-pass' });
    const second = service.start({ password: 'concurrent-pass' });

    resolveStart?.({ url: TUNNEL_URL });

    const [a, b] = await Promise.all([first, second]);
    expect(a).toEqual(b);
    expect(startCallCount).toBe(1);
  });

  describe('tunnel access integration', () => {
    function createAccessSpy() {
      return {
        beginTunnelSession: vi.fn(),
        endTunnelSession: vi.fn(),
        issueToken: vi.fn(() => null),
        consumeToken: vi.fn(() => null),
        isValidSession: vi.fn(() => false),
      } satisfies TunnelAccessService;
    }

    it('calls beginTunnelSession on successful start', async () => {
      const access = createAccessSpy();
      const tunnel = createFakeTunnel();
      const service = createService(tunnel, { access });

      await service.start();

      expect(access.beginTunnelSession).toHaveBeenCalledOnce();
      expect(access.endTunnelSession).not.toHaveBeenCalled();
    });

    it('calls endTunnelSession on stop', async () => {
      const access = createAccessSpy();
      const tunnel = createFakeTunnel();
      const service = createService(tunnel, { access });

      await service.start();
      await service.stop();

      expect(access.endTunnelSession).toHaveBeenCalledOnce();
    });

    it('calls endTunnelSession when start fails', async () => {
      const access = createAccessSpy();
      const tunnel = createFakeTunnel({
        start: async () => {
          throw new Error('tunnel spawn failed');
        },
      });
      const service = createService(tunnel, { access });

      await service.start();

      expect(access.beginTunnelSession).not.toHaveBeenCalled();
      expect(access.endTunnelSession).toHaveBeenCalledOnce();
    });

    it('calls endTunnelSession on unexpected exit', async () => {
      const access = createAccessSpy();
      const tunnel = createFakeTunnel();
      const service = createService(tunnel, { access });

      await service.start({ password: 'p' });
      tunnel.triggerUnexpectedExit();

      expect(access.endTunnelSession).toHaveBeenCalledOnce();
    });
  });
});

describe('createTunnelService interruption persistence', () => {
  const FIXED_NOW = new Date('2026-08-15T03:00:00.000Z');

  it('marks an interruption on shutdown while the tunnel is on', async () => {
    const interruptions = createInMemoryTunnelInterruptionStore();
    const tunnel = createFakeTunnel();
    const service = createService(tunnel, {
      now: () => FIXED_NOW,
      interruptions,
    });

    await service.start({ password: 'example-password' });
    await service.shutdown();

    expect(interruptions.read()).toEqual(FIXED_NOW);
    expect(service.getState()).toEqual({ kind: 'off' });
  });

  it('does not mark an interruption on shutdown while the tunnel is off', async () => {
    const interruptions = createInMemoryTunnelInterruptionStore();
    const tunnel = createFakeTunnel();
    const service = createService(tunnel, { interruptions });

    await service.shutdown();

    expect(interruptions.read()).toBeNull();
  });

  it('clears the interruption on explicit stop()', async () => {
    const interruptions = createInMemoryTunnelInterruptionStore();
    const tunnel = createFakeTunnel();
    const service = createService(tunnel, { interruptions });

    interruptions.markInterrupted(FIXED_NOW);
    await service.stop();

    expect(interruptions.read()).toBeNull();
  });

  it('clears the interruption after a successful start()', async () => {
    const interruptions = createInMemoryTunnelInterruptionStore();
    const tunnel = createFakeTunnel();
    const service = createService(tunnel, { interruptions });

    interruptions.markInterrupted(FIXED_NOW);
    await service.start({ password: 'example-password' });

    expect(interruptions.read()).toBeNull();
  });

  it('does not clear the interruption when start fails', async () => {
    const interruptions = createInMemoryTunnelInterruptionStore();
    const tunnel = createFakeTunnel({
      start: async () => {
        throw new Error('tunnel spawn failed');
      },
    });
    const service = createService(tunnel, { interruptions });

    interruptions.markInterrupted(FIXED_NOW);
    await service.start({ password: 'example-password' });

    expect(interruptions.read()).toEqual(FIXED_NOW);
  });

  it('returns the stored interruption timestamp from getInterruptedAt()', async () => {
    const interruptions = createInMemoryTunnelInterruptionStore();
    const tunnel = createFakeTunnel();
    const service = createService(tunnel, { interruptions });

    interruptions.markInterrupted(FIXED_NOW);
    expect(service.getInterruptedAt()).toEqual(FIXED_NOW);
  });
});

// bdboard-9rz: トンネル経由の書き込みを開放してよいかは、そのトンネルを起動した
// 資格情報の強度だけで決まる。短いパスワードでの起動自体は引き続き許可し(5149cd4)、
// 書き込みだけを閉じる。
describe('createTunnelService write access gate', () => {
  it('opens writes for an auto-generated passphrase', async () => {
    const tunnel = createFakeTunnel();
    const service = createService(tunnel);

    expect(service.isWriteAllowed()).toBe(false);
    await service.start();
    expect(service.isWriteAllowed()).toBe(true);
  });

  it('keeps writes closed for a user-supplied password below the threshold', async () => {
    const tunnel = createFakeTunnel();
    const service = createService(tunnel);

    const state = await service.start({ password: 'a'.repeat(11) });

    // 起動そのものは成功する。閉じるのは書き込みだけ。
    expect(state.kind).toBe('on');
    expect(service.isWriteAllowed()).toBe(false);
  });

  it('opens writes for a user-supplied password at the threshold', async () => {
    const tunnel = createFakeTunnel();
    const service = createService(tunnel);

    await service.start({ password: 'a'.repeat(12) });

    expect(service.isWriteAllowed()).toBe(true);
  });

  it('revokes write access on stop', async () => {
    const tunnel = createFakeTunnel();
    const service = createService(tunnel);

    await service.start();
    await service.stop();

    expect(service.isWriteAllowed()).toBe(false);
  });

  it('revokes write access when the tunnel process dies unexpectedly', async () => {
    const tunnel = createFakeTunnel();
    const service = createService(tunnel);

    await service.start();
    tunnel.triggerUnexpectedExit();

    expect(service.isWriteAllowed()).toBe(false);
  });

  it('does not report write access while the tunnel failed to start', async () => {
    const tunnel = createFakeTunnel({
      start: vi.fn(async () => {
        throw new Error('cloudflared boom');
      }),
    });
    const service = createService(tunnel);

    const state = await service.start();

    expect(state.kind).toBe('error');
    expect(service.isWriteAllowed()).toBe(false);
  });
});

describe('createTunnelService availability re-probing (bdboard-syr)', () => {
  it('re-probes after the negative cache expires and leaves unavailable', async () => {
    const tunnel = createFakeTunnel();
    tunnel.isAvailableMock.mockResolvedValueOnce(false).mockResolvedValue(true);
    let nowMs = Date.parse('2026-08-14T12:00:00.000Z');
    const service = createService(tunnel, { now: () => new Date(nowMs) });

    expect(await service.probeAvailability()).toBe(false);
    // 「未判定」と「判定済みで使えない」を取り違えると、使えないのに
    // 使える扱いになる。probe 済みでも false は false。
    expect(service.getAvailability()).toBe(false);
    expect(service.getState()).toEqual({ kind: 'unavailable' });

    // TTL 内は再プローブしない (毎リクエストで PATH を舐めないための キャッシュ)。
    nowMs += 1_000;
    expect(await service.probeAvailability()).toBe(false);
    expect(tunnel.isAvailableMock).toHaveBeenCalledTimes(1);

    // TTL 経過後は再プローブし、後から入った cloudflared を拾う。
    nowMs += TUNNEL_AVAILABILITY_RECHECK_MS;
    expect(await service.probeAvailability()).toBe(true);
    expect(tunnel.isAvailableMock).toHaveBeenCalledTimes(2);
    expect(service.getAvailability()).toBe(true);
    // unavailable に落とした state も戻さないと、UI は使えないままに見える。
    expect(service.getState()).toEqual({ kind: 'off' });
  });

  it('keeps a positive availability result cached without re-probing', async () => {
    const tunnel = createFakeTunnel();
    let nowMs = Date.parse('2026-08-14T12:00:00.000Z');
    const service = createService(tunnel, { now: () => new Date(nowMs) });

    expect(await service.probeAvailability()).toBe(true);
    nowMs += TUNNEL_AVAILABILITY_RECHECK_MS * 10;
    expect(await service.probeAvailability()).toBe(true);
    expect(tunnel.isAvailableMock).toHaveBeenCalledTimes(1);
  });

  it('re-probes after a probe threw, instead of pinning unavailable forever', async () => {
    const tunnel = createFakeTunnel();
    tunnel.isAvailableMock
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue(true);
    let nowMs = Date.parse('2026-08-14T12:00:00.000Z');
    const service = createService(tunnel, { now: () => new Date(nowMs) });

    expect(await service.probeAvailability()).toBe(false);
    nowMs += TUNNEL_AVAILABILITY_RECHECK_MS;
    expect(await service.probeAvailability()).toBe(true);
  });
});
