import { describe, expect, it, vi } from 'vitest';
import type {
  HygieneThresholdsConfig,
  HygieneThresholdsConfigPort,
} from '../../application/ports/hygiene-thresholds-config.js';
import { DEFAULT_HYGIENE_THRESHOLDS } from '../../domain/hygiene-thresholds.js';
import {
  computeHygieneThresholdsVersion,
  createHygieneThresholdsRoutes,
} from './hygiene-thresholds-routes.js';

const LOCAL_HOST = 'localhost:8787';

const LOCAL_ENV = { incoming: { socket: { remoteAddress: '127.0.0.1', localPort: 8787 } } };

function withLocalHost(init: RequestInit = {}): RequestInit {
  const headers = new Headers(init.headers);
  if (!headers.has('Host')) {
    headers.set('Host', LOCAL_HOST);
  }
  return { ...init, headers };
}
const EMPTY_VERSION = computeHygieneThresholdsVersion(undefined);

function makeStore(overrides: Partial<HygieneThresholdsConfigPort> = {}): HygieneThresholdsConfigPort {
  return {
    read: vi.fn(async () => undefined),
    write: vi.fn(async () => undefined),
    ...overrides,
  };
}

function makePersistedStore(initial?: HygieneThresholdsConfig): HygieneThresholdsConfigPort {
  let current = initial;
  return makeStore({
    read: vi.fn(async () => current),
    write: vi.fn(async (config) => {
      current = config;
    }),
  });
}

describe('createHygieneThresholdsRoutes', () => {
  it('returns default thresholds when no config exists', async () => {
    const response = await createHygieneThresholdsRoutes({ store: makeStore() }).request(
      '/api/settings/hygiene-thresholds',
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      staleInProgressAfterMs: DEFAULT_HYGIENE_THRESHOLDS.staleInProgressAfterMs,
      highPriorityMax: DEFAULT_HYGIENE_THRESHOLDS.highPriorityMax,
      stalePendingDecisionAfterMs: DEFAULT_HYGIENE_THRESHOLDS.stalePendingDecisionAfterMs,
      closedWithoutEvidenceWindowMs:
        DEFAULT_HYGIENE_THRESHOLDS.closedWithoutEvidenceWindowMs,
      version: EMPTY_VERSION,
      defaults: {
        staleInProgressAfterMs: DEFAULT_HYGIENE_THRESHOLDS.staleInProgressAfterMs,
        highPriorityMax: DEFAULT_HYGIENE_THRESHOLDS.highPriorityMax,
        stalePendingDecisionAfterMs: DEFAULT_HYGIENE_THRESHOLDS.stalePendingDecisionAfterMs,
        closedWithoutEvidenceWindowMs:
          DEFAULT_HYGIENE_THRESHOLDS.closedWithoutEvidenceWindowMs,
      },
    });
  });

  it('writes a valid config', async () => {
    const store = makePersistedStore();
    const response = await createHygieneThresholdsRoutes({ store }).request(
      '/api/settings/hygiene-thresholds',
      withLocalHost({
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          staleInProgressAfterMs: 3 * 24 * 60 * 60_000,
          highPriorityMax: 2,
          stalePendingDecisionAfterMs: 1 * 24 * 60 * 60_000,
          version: EMPTY_VERSION,
        }),
      }),
      LOCAL_ENV,
    );
    expect(response.status).toBe(200);
    expect(store.write).toHaveBeenCalledWith({
      staleInProgressAfterMs: 3 * 24 * 60 * 60_000,
      highPriorityMax: 2,
      stalePendingDecisionAfterMs: 1 * 24 * 60 * 60_000,
    });
  });

  it('writes closedWithoutEvidenceWindowMs', async () => {
    const store = makePersistedStore();
    const response = await createHygieneThresholdsRoutes({ store }).request(
      '/api/settings/hygiene-thresholds',
      withLocalHost({
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          closedWithoutEvidenceWindowMs: 5 * 24 * 60 * 60_000,
          version: EMPTY_VERSION,
        }),
      }),
      LOCAL_ENV,
    );
    expect(response.status).toBe(200);
    expect(store.write).toHaveBeenCalledWith({
      closedWithoutEvidenceWindowMs: 5 * 24 * 60 * 60_000,
    });
  });

  it('rejects invalid priority with 400', async () => {
    const response = await createHygieneThresholdsRoutes({ store: makeStore() }).request(
      '/api/settings/hygiene-thresholds',
      withLocalHost({
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          highPriorityMax: 9,
          version: EMPTY_VERSION,
        }),
      }),
      LOCAL_ENV,
    );
    expect(response.status).toBe(400);
  });

  it('returns 409 on version mismatch', async () => {
    const response = await createHygieneThresholdsRoutes({ store: makeStore() }).request(
      '/api/settings/hygiene-thresholds',
      withLocalHost({
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          highPriorityMax: 2,
          version: 'stale-version',
        }),
      }),
      LOCAL_ENV,
    );
    expect(response.status).toBe(409);
  });

  it('rejects a non-local unauthenticated write', async () => {
    const store = makeStore();
    const response = await createHygieneThresholdsRoutes({ store }).request(
      '/api/settings/hygiene-thresholds',
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'cf-ray': 'abc' },
        body: JSON.stringify({
          highPriorityMax: 2,
          version: EMPTY_VERSION,
        }),
      },
      { incoming: { socket: { remoteAddress: '192.0.2.1' } } },
    );
    expect(response.status).toBe(403);
    expect(store.write).not.toHaveBeenCalled();
  });
});
