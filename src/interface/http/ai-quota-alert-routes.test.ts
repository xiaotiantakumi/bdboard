import { describe, expect, it, vi } from 'vitest';
import type {
  AiQuotaAlertConfig,
  AiQuotaAlertConfigPort,
} from '../../application/ports/ai-quota-alert-config.js';
import { DEFAULT_AI_QUOTA_ALERT_THRESHOLD_PERCENT } from '../../domain/ai-quota-alert-thresholds.js';
import {
  computeAiQuotaAlertVersion,
  createAiQuotaAlertRoutes,
} from './ai-quota-alert-routes.js';

const LOCAL_HOST = 'localhost:8787';

const LOCAL_ENV = { incoming: { socket: { remoteAddress: '127.0.0.1', localPort: 8787 } } };

function withLocalHost(init: RequestInit = {}): RequestInit {
  const headers = new Headers(init.headers);
  if (!headers.has('Host')) {
    headers.set('Host', LOCAL_HOST);
  }
  return { ...init, headers };
}
const EMPTY_VERSION = computeAiQuotaAlertVersion(undefined);

function makeStore(overrides: Partial<AiQuotaAlertConfigPort> = {}): AiQuotaAlertConfigPort {
  return {
    read: vi.fn(async () => undefined),
    write: vi.fn(async () => undefined),
    ...overrides,
  };
}

function makePersistedStore(initial?: AiQuotaAlertConfig): AiQuotaAlertConfigPort {
  let current = initial;
  return makeStore({
    read: vi.fn(async () => current),
    write: vi.fn(async (config) => {
      current = config;
    }),
  });
}

describe('createAiQuotaAlertRoutes', () => {
  it('returns default threshold when no config exists', async () => {
    const response = await createAiQuotaAlertRoutes({ store: makeStore() }).request(
      '/api/settings/ai-quota-alert',
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      thresholdPercent: DEFAULT_AI_QUOTA_ALERT_THRESHOLD_PERCENT,
      version: EMPTY_VERSION,
      defaults: { thresholdPercent: DEFAULT_AI_QUOTA_ALERT_THRESHOLD_PERCENT },
    });
  });

  it('writes a valid config', async () => {
    const store = makePersistedStore();
    const response = await createAiQuotaAlertRoutes({ store }).request(
      '/api/settings/ai-quota-alert',
      withLocalHost({
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          thresholdPercent: 15,
          version: EMPTY_VERSION,
        }),
      }),
      LOCAL_ENV,
    );
    expect(response.status).toBe(200);
    expect(store.write).toHaveBeenCalledWith({ thresholdPercent: 15 });
  });

  it('rejects invalid threshold with 400', async () => {
    const response = await createAiQuotaAlertRoutes({ store: makeStore() }).request(
      '/api/settings/ai-quota-alert',
      withLocalHost({
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          thresholdPercent: 100,
          version: EMPTY_VERSION,
        }),
      }),
      LOCAL_ENV,
    );
    expect(response.status).toBe(400);
  });

  it('returns 409 on version mismatch', async () => {
    const response = await createAiQuotaAlertRoutes({ store: makeStore() }).request(
      '/api/settings/ai-quota-alert',
      withLocalHost({
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          thresholdPercent: 15,
          version: 'stale-version',
        }),
      }),
      LOCAL_ENV,
    );
    expect(response.status).toBe(409);
  });

  it('rejects a non-local unauthenticated write', async () => {
    const store = makeStore();
    const response = await createAiQuotaAlertRoutes({ store }).request(
      '/api/settings/ai-quota-alert',
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'cf-ray': 'abc' },
        body: JSON.stringify({
          thresholdPercent: 15,
          version: EMPTY_VERSION,
        }),
      },
      { incoming: { socket: { remoteAddress: '192.0.2.1' } } },
    );
    expect(response.status).toBe(403);
    expect(store.write).not.toHaveBeenCalled();
  });
});
