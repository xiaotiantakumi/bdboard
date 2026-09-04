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

  it('returns BDBOARD_E2E_PORT verbatim when set (no auto-allocation)', () => {
    withEnv('8799', () => {
      expect(resolveE2EPort()).toBe('8799');
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

  it('does not auto-allocate the always-on dev port 8787', () => {
    withEnv(undefined, () => {
      expect(Number.parseInt(resolveE2EPort(), 10)).not.toBe(ALWAYS_ON_DEV_PORT);
    });
  });

  it('auto-allocates a non-fixed port (not hard-coded 8799)', () => {
    withEnv(undefined, () => {
      const first = resolveE2EPort();
      const second = resolveE2EPort();
      for (const value of [first, second]) {
        const port = Number.parseInt(value, 10);
        expect(Number.isFinite(port)).toBe(true);
        expect(port).not.toBe(8799);
        expect(port).not.toBe(ALWAYS_ON_DEV_PORT);
      }
    });
  });
});
