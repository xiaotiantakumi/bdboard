import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  WrongHealthServerError,
  fetchHealthViaFetch,
  waitForHealth,
  type FetchHealthResult,
  type HealthBody,
} from './wait-for-health.js';

const HEALTH_URL = 'http://127.0.0.1:8799/api/health';
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
        url: HEALTH_URL,
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
        url: HEALTH_URL,
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
      url: HEALTH_URL,
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
        url: HEALTH_URL,
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
        url: HEALTH_URL,
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
      url: HEALTH_URL,
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
        url: HEALTH_URL,
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

  it('throws deadline message without answered HTTP when only network_error was seen', async () => {
    const fetchHealth = vi.fn(
      async (): Promise<FetchHealthResult> => ({
        kind: 'network_error',
        error: new Error('ECONNREFUSED'),
      }),
    );

    const err = await waitForHealth({
      url: HEALTH_URL,
      port: PORT,
      expectedNonce: EXPECTED,
      isChildAlive: () => true,
      fetchHealth,
      timeoutMs: 20,
      pollIntervalMs: 1,
      sleep: () => new Promise((r) => setTimeout(r, 1)),
    }).catch((e: unknown) => e);

    expect(String(err)).toMatch(/did not become healthy within 20ms:/);
    expect(String(err)).not.toMatch(/answered HTTP/);
  });

  it('throws deadline message with answered HTTP when only http_error was seen', async () => {
    const fetchHealth = vi.fn(
      async (): Promise<FetchHealthResult> => ({ kind: 'http_error', status: 503 }),
    );

    const err = await waitForHealth({
      url: HEALTH_URL,
      port: PORT,
      expectedNonce: EXPECTED,
      isChildAlive: () => true,
      fetchHealth,
      timeoutMs: 20,
      pollIntervalMs: 1,
      sleep: () => new Promise((r) => setTimeout(r, 1)),
    }).catch((e: unknown) => e);

    expect(String(err)).toMatch(/answered HTTP \(last: status 503\)/);
    expect(String(err)).toMatch(`port ${PORT}`);
    expect(String(err)).toMatch(`instanceNonce=${EXPECTED}`);
    expect(String(err)).toMatch(/another process may be holding the port/);
  });

  it('throws the custom error from onChildNotAlive when the child is not alive', async () => {
    const custom = new Error('exited (code=1, signal=null)');
    const onChildNotAlive = vi.fn(() => custom);
    const fetchHealth = vi.fn(
      async (): Promise<FetchHealthResult> => ({
        kind: 'network_error',
        error: new Error('ECONNREFUSED'),
      }),
    );

    await expect(
      waitForHealth({
        url: HEALTH_URL,
        port: PORT,
        expectedNonce: EXPECTED,
        isChildAlive: () => false,
        onChildNotAlive,
        fetchHealth,
        timeoutMs: 1_000,
        pollIntervalMs: 1,
        sleep: async () => {},
      }),
    ).rejects.toBe(custom);

    expect(onChildNotAlive).toHaveBeenCalledTimes(1);
    expect(fetchHealth).not.toHaveBeenCalled();
  });

  it('throws immediately with invalid_body when ok body is null (no retry)', async () => {
    const fetchHealth = vi.fn(
      async (): Promise<FetchHealthResult> => ({
        kind: 'ok',
        body: null as unknown as HealthBody,
      }),
    );
    const sleep = vi.fn(async () => {});

    const err = await waitForHealth({
      url: HEALTH_URL,
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
    expect(fetchHealth).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('throws immediately with invalid_body when ok field is missing (no retry)', async () => {
    const fetchHealth = vi.fn(
      async (): Promise<FetchHealthResult> => ({
        kind: 'ok',
        body: { instanceNonce: EXPECTED },
      }),
    );
    const sleep = vi.fn(async () => {});

    const err = await waitForHealth({
      url: HEALTH_URL,
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
    expect(fetchHealth).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});

describe('fetchHealthViaFetch', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns ok with body for 200 + valid health JSON', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ ok: true, instanceNonce: 'x' }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchHealthViaFetch(HEALTH_URL);

    expect(result).toEqual({ kind: 'ok', body: { ok: true, instanceNonce: 'x' } });
    expect(fetchMock).toHaveBeenCalledWith(HEALTH_URL);
  });

  it('returns invalid_body for 200 + HTML body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response('<!doctype html><html></html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
      ),
    );

    const result = await fetchHealthViaFetch(HEALTH_URL);

    expect(result.kind).toBe('invalid_body');
  });

  it('returns http_error for non-2xx status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 404 })),
    );

    const result = await fetchHealthViaFetch(HEALTH_URL);

    expect(result).toEqual({ kind: 'http_error', status: 404 });
  });

  it('returns network_error when fetch throws', async () => {
    const thrown = new Error('ECONNREFUSED');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw thrown;
      }),
    );

    const result = await fetchHealthViaFetch(HEALTH_URL);

    expect(result).toEqual({ kind: 'network_error', error: thrown });
  });
});
