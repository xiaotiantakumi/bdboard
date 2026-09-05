import { describe, expect, it, vi } from 'vitest';
import {
  WrongHealthServerError,
  waitForHealth,
  type FetchHealthResult,
} from './wait-for-health.js';

const URL = 'http://127.0.0.1:8799/api/health';
const PORT = 8799;
const EXPECTED = 'expected-nonce-1111';

function okBody(instanceNonce: string): FetchHealthResult {
  return { kind: 'ok', body: { ok: true, instanceNonce } };
}

describe('waitForHealth', () => {
  it('completes when the server returns the expected instance nonce', async () => {
    const fetchHealth = vi.fn(async () => okBody(EXPECTED));

    await expect(
      waitForHealth({
        url: URL,
        port: PORT,
        expectedNonce: EXPECTED,
        isChildAlive: () => true,
        fetchHealth,
        timeoutMs: 1_000,
        pollIntervalMs: 1,
        sleep: async () => {},
      }),
    ).resolves.toBeUndefined();

    expect(fetchHealth).toHaveBeenCalledTimes(1);
  });

  it('throws immediately when another server returns a different nonce (no retry)', async () => {
    const fetchHealth = vi.fn(async () => okBody('foreign-nonce-2222'));
    const sleep = vi.fn(async () => {});

    await expect(
      waitForHealth({
        url: URL,
        port: PORT,
        expectedNonce: EXPECTED,
        isChildAlive: () => true,
        fetchHealth,
        timeoutMs: 5_000,
        pollIntervalMs: 100,
        sleep,
      }),
    ).rejects.toBeInstanceOf(WrongHealthServerError);

    expect(fetchHealth).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('throws immediately when health ok but instanceNonce field is missing', async () => {
    const fetchHealth = vi.fn(
      async (): Promise<FetchHealthResult> => ({ kind: 'ok', body: { ok: true } }),
    );
    const sleep = vi.fn(async () => {});

    const err = await waitForHealth({
      url: URL,
      port: PORT,
      expectedNonce: EXPECTED,
      isChildAlive: () => true,
      fetchHealth,
      timeoutMs: 5_000,
      pollIntervalMs: 100,
      sleep,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(WrongHealthServerError);
    expect((err as WrongHealthServerError).actualNonce).toBeUndefined();
    expect(String(err)).toMatch(/missing instanceNonce field/);
    expect(String(err)).toMatch(String(PORT));
    expect(fetchHealth).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('retries on connection refusal then completes when own nonce appears', async () => {
    let calls = 0;
    const fetchHealth = vi.fn(async (): Promise<FetchHealthResult> => {
      calls += 1;
      if (calls < 3) {
        return { kind: 'network_error', error: new Error('ECONNREFUSED') };
      }
      return okBody(EXPECTED);
    });
    const sleep = vi.fn(async () => {});

    await expect(
      waitForHealth({
        url: URL,
        port: PORT,
        expectedNonce: EXPECTED,
        isChildAlive: () => true,
        fetchHealth,
        timeoutMs: 1_000,
        pollIntervalMs: 1,
        sleep,
      }),
    ).resolves.toBeUndefined();

    expect(fetchHealth).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('throws when the child process exits before becoming healthy', async () => {
    const fetchHealth = vi.fn(
      async (): Promise<FetchHealthResult> => ({
        kind: 'network_error',
        error: new Error('ECONNREFUSED'),
      }),
    );

    await expect(
      waitForHealth({
        url: URL,
        port: PORT,
        expectedNonce: EXPECTED,
        isChildAlive: () => false,
        fetchHealth,
        timeoutMs: 1_000,
        pollIntervalMs: 1,
        sleep: async () => {},
      }),
    ).rejects.toThrow(/exited before becoming healthy/);

    expect(fetchHealth).not.toHaveBeenCalled();
  });

  it('throws immediately when response is 200 but body is not health JSON (no retry)', async () => {
    const fetchHealth = vi.fn(
      async (): Promise<FetchHealthResult> => ({
        kind: 'invalid_body',
        error: new SyntaxError('Unexpected token < in JSON'),
      }),
    );
    const sleep = vi.fn(async () => {});

    const err = await waitForHealth({
      url: URL,
      port: PORT,
      expectedNonce: EXPECTED,
      isChildAlive: () => true,
      fetchHealth,
      timeoutMs: 5_000,
      pollIntervalMs: 100,
      sleep,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(WrongHealthServerError);
    expect((err as WrongHealthServerError).reason).toBe('invalid_body');
    expect(String(err)).toMatch(/did not return bdboard health JSON/);
    expect(String(err)).toMatch(String(PORT));
    expect(fetchHealth).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('retries on http_error then completes when own nonce appears', async () => {
    let calls = 0;
    const fetchHealth = vi.fn(async (): Promise<FetchHealthResult> => {
      calls += 1;
      if (calls < 3) {
        return { kind: 'http_error', status: 503 };
      }
      return okBody(EXPECTED);
    });
    const sleep = vi.fn(async () => {});

    await expect(
      waitForHealth({
        url: URL,
        port: PORT,
        expectedNonce: EXPECTED,
        isChildAlive: () => true,
        fetchHealth,
        timeoutMs: 1_000,
        pollIntervalMs: 1,
        sleep,
      }),
    ).resolves.toBeUndefined();

    expect(fetchHealth).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });
});
