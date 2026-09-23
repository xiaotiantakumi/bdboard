import { describe, expect, it, vi } from 'vitest';
import type { TunnelProcess } from '../../ports/tunnel.js';
import { TUNNEL_AVAILABILITY_RECHECK_MS } from './availability-recheck.js';
import { probeAvailability, setAvailability } from './availability.js';
import { createTunnelServiceState } from './state.js';
import type { TunnelServiceDeps } from './types.js';

function createDeps(isAvailable: () => Promise<boolean>, now: () => Date): TunnelServiceDeps {
  const tunnel: TunnelProcess = {
    start: vi.fn(),
    stop: vi.fn(),
    isAvailable,
  };
  return {
    tunnel,
    now,
    username: 'example-user',
    generatePassword: () => 'generated-pass-phrase',
  };
}

/**
 * bdboard-ksvs: setAvailability/probeAvailability を createTunnelService() の
 * クロージャから ./availability.ts へ切り出し、共有していた `let availability` /
 * `let state` を TunnelServiceState コンテナ経由の読み書きに置き換えた。分割前
 * (bdboard-sso1.64) の判定条件・TTL・エラー処理は変えていない。公開 API 経由の
 * 同等シナリオは tunnel-service.test.ts の
 * 「createTunnelService availability re-probing (bdboard-syr)」に既存。
 */
describe('tunnel-service/availability.ts (bdboard-ksvs state-container split)', () => {
  describe('setAvailability', () => {
    it('drops a non-unavailable state into unavailable when the value is false', () => {
      const ctx = createTunnelServiceState();
      ctx.state = { kind: 'off' };
      const now = new Date('2026-08-14T12:00:00.000Z');
      const deps = createDeps(vi.fn(), () => now);

      setAvailability(ctx, deps, false);

      expect(ctx.state).toEqual({ kind: 'unavailable' });
      expect(ctx.availability).toEqual({ value: false, at: now.getTime() });
    });

    it('leaves a non-unavailable state alone when the value is true', () => {
      const ctx = createTunnelServiceState();
      ctx.state = { kind: 'starting' };
      const deps = createDeps(vi.fn(), () => new Date());

      setAvailability(ctx, deps, true);

      expect(ctx.state).toEqual({ kind: 'starting' });
    });

    it('recovers unavailable back to off once cloudflared becomes available again (bdboard-syr)', () => {
      const ctx = createTunnelServiceState();
      ctx.state = { kind: 'unavailable' };
      const deps = createDeps(vi.fn(), () => new Date());

      setAvailability(ctx, deps, true);

      expect(ctx.state).toEqual({ kind: 'off' });
    });
  });

  describe('probeAvailability', () => {
    it('probes once and caches a positive result permanently', async () => {
      const isAvailable = vi.fn(async () => true);
      const deps = createDeps(isAvailable, () => new Date('2026-08-14T12:00:00.000Z'));
      const ctx = createTunnelServiceState();

      expect(await probeAvailability(ctx, deps)).toBe(true);
      expect(await probeAvailability(ctx, deps)).toBe(true);

      expect(isAvailable).toHaveBeenCalledTimes(1);
    });

    it('caches a negative result until TUNNEL_AVAILABILITY_RECHECK_MS elapses, then re-probes', async () => {
      const isAvailable = vi.fn(async () => false);
      const start = new Date('2026-08-14T12:00:00.000Z');
      let now = start;
      const deps = createDeps(isAvailable, () => now);
      const ctx = createTunnelServiceState();

      expect(await probeAvailability(ctx, deps)).toBe(false);
      expect(isAvailable).toHaveBeenCalledTimes(1);

      // One millisecond short of the TTL: the `elapsed < TTL` check (source of truth:
      // ./availability.ts's probeAvailability) is still true, so this must be served
      // from cache without calling isAvailable() again.
      now = new Date(start.getTime() + TUNNEL_AVAILABILITY_RECHECK_MS - 1);
      expect(await probeAvailability(ctx, deps)).toBe(false);
      expect(isAvailable).toHaveBeenCalledTimes(1); // still within TTL: no re-probe

      // Exactly at the TTL boundary: `elapsed < TTL` is false (elapsed === TTL), so this
      // must re-probe. This pins the strict `<` (an off-by-one `<=` would instead cache
      // through this tick and only re-probe on the next millisecond).
      now = new Date(start.getTime() + TUNNEL_AVAILABILITY_RECHECK_MS);
      expect(await probeAvailability(ctx, deps)).toBe(false);
      expect(isAvailable).toHaveBeenCalledTimes(2); // TTL elapsed exactly: re-probed
    });

    it('treats a throwing probe as unavailable instead of leaving availability unset (probe failure)', async () => {
      const isAvailable = vi.fn(async () => {
        throw new Error('cloudflared not on PATH');
      });
      const now = new Date('2026-08-14T12:00:00.000Z');
      const deps = createDeps(isAvailable, () => now);
      const ctx = createTunnelServiceState();
      ctx.state = { kind: 'off' };

      const result = await probeAvailability(ctx, deps);

      expect(result).toBe(false);
      expect(ctx.state).toEqual({ kind: 'unavailable' });
      expect(ctx.availability).toEqual({ value: false, at: now.getTime() });
    });
  });
});
