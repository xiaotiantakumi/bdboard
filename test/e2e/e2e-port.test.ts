import { afterEach, describe, expect, it } from 'vitest';
import { ALWAYS_ON_DEV_PORT, resolveE2EPort } from './e2e-port.js';

const ENV_KEY = 'BDBOARD_E2E_PORT';

describe('resolveE2EPort', () => {
  let savedEnv: string | undefined;

  afterEach(() => {
    if (savedEnv === undefined) {
      delete process.env[ENV_KEY];
    } else {
      process.env[ENV_KEY] = savedEnv;
    }
  });

  function withEnv(value: string | undefined, fn: () => void): void {
    savedEnv = process.env[ENV_KEY];
    if (value === undefined) {
      delete process.env[ENV_KEY];
    } else {
      process.env[ENV_KEY] = value;
    }
    fn();
  }

  it('returns validated BDBOARD_E2E_PORT when set (no auto-allocation)', () => {
    withEnv('8799', () => {
      expect(resolveE2EPort()).toBe('8799');
    });
  });

  it('throws when BDBOARD_E2E_PORT is the always-on dev port 8787', () => {
    withEnv(String(ALWAYS_ON_DEV_PORT), () => {
      expect(() => resolveE2EPort()).toThrow(/8787/);
      expect(() => resolveE2EPort()).toThrow(/always-on dev server port/);
      expect(() => resolveE2EPort()).toThrow(/live developer data/);
    });
  });

  it('throws when BDBOARD_E2E_PORT is non-numeric', () => {
    withEnv('abc', () => {
      expect(() => resolveE2EPort()).toThrow(/BDBOARD_E2E_PORT/);
      expect(() => resolveE2EPort()).toThrow(/non-numeric/);
    });
  });

  it('throws when BDBOARD_E2E_PORT is above the valid range', () => {
    withEnv('99999', () => {
      expect(() => resolveE2EPort()).toThrow(/outside valid range/);
    });
  });

  it('throws when BDBOARD_E2E_PORT is below the valid range', () => {
    withEnv('0', () => {
      expect(() => resolveE2EPort()).toThrow(/outside valid range/);
    });
  });

  it('returns a parseable port number when env is unset', () => {
    withEnv(undefined, () => {
      const port = Number.parseInt(resolveE2EPort(), 10);
      expect(Number.isFinite(port)).toBe(true);
      expect(port).toBeGreaterThanOrEqual(1);
      expect(port).toBeLessThanOrEqual(65_535);
    });
  });

  it('does not return a known fixed port when auto-allocating', () => {
    withEnv(undefined, () => {
      const port = Number.parseInt(resolveE2EPort(), 10);
      // 自動採番の結果が既知の固定ポート (8799/8787) ではないことだけを確認する。
      // ephemeral 範囲外なのでこの 2 値は構造的に出得ず、これは回帰の網であって非決定性の証明ではない。
      expect(Number.isFinite(port)).toBe(true);
      expect(port).not.toBe(8799);
      expect(port).not.toBe(ALWAYS_ON_DEV_PORT);
    });
  });
});
