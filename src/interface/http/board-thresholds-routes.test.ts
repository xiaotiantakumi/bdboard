import { describe, expect, it, vi } from 'vitest';
import type {
  BoardThresholdsConfig,
  BoardThresholdsConfigPort,
} from '../../application/ports/board-thresholds-config.js';
import { DEFAULT_LIVENESS_THRESHOLDS } from '../../domain/liveness.js';
import { DEFAULT_STALLED_THRESHOLDS } from '../../domain/stalled.js';
import {
  computeBoardThresholdsVersion,
  createBoardThresholdsRoutes,
} from './board-thresholds-routes.js';

const LOCAL_ENV = { incoming: { socket: { remoteAddress: '127.0.0.1' } } };
const EMPTY_VERSION = computeBoardThresholdsVersion(undefined);

function makeStore(overrides: Partial<BoardThresholdsConfigPort> = {}): BoardThresholdsConfigPort {
  return {
    read: vi.fn(async () => undefined),
    write: vi.fn(async () => undefined),
    ...overrides,
  };
}

function makePersistedStore(initial?: BoardThresholdsConfig): BoardThresholdsConfigPort {
  let current = initial;
  return makeStore({
    read: vi.fn(async () => current),
    write: vi.fn(async (config) => {
      current = config;
    }),
  });
}

describe('createBoardThresholdsRoutes', () => {
  it('returns default effective thresholds when no config exists', async () => {
    const response = await createBoardThresholdsRoutes({ store: makeStore() }).request(
      '/api/settings/board-thresholds',
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      stalledAfterMs: DEFAULT_STALLED_THRESHOLDS.stalledAfterMs,
      livenessActiveMs: DEFAULT_LIVENESS_THRESHOLDS.activeMs,
      livenessIdleMs: DEFAULT_LIVENESS_THRESHOLDS.idleMs,
      livenessStaleMs: DEFAULT_LIVENESS_THRESHOLDS.staleMs,
      inProgressWipLimit: null,
      inProgressWipLimitByProject: {},
      version: EMPTY_VERSION,
      defaults: {
        stalledAfterMs: DEFAULT_STALLED_THRESHOLDS.stalledAfterMs,
        livenessActiveMs: DEFAULT_LIVENESS_THRESHOLDS.activeMs,
        livenessIdleMs: DEFAULT_LIVENESS_THRESHOLDS.idleMs,
        livenessStaleMs: DEFAULT_LIVENESS_THRESHOLDS.staleMs,
        inProgressWipLimit: null,
        inProgressWipLimitByProject: {},
      },
    });
  });

  it('writes a valid config', async () => {
    const store = makePersistedStore();
    const response = await createBoardThresholdsRoutes({ store }).request(
      '/api/settings/board-thresholds',
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          stalledAfterMs: 12 * 60 * 60_000,
          livenessActiveMs: 60_000,
          livenessIdleMs: 20 * 60_000,
          livenessStaleMs: 48 * 60 * 60_000,
          version: EMPTY_VERSION,
        }),
      },
      LOCAL_ENV,
    );
    expect(response.status).toBe(200);
    expect(store.write).toHaveBeenCalledWith({
      stalledAfterMs: 12 * 60 * 60_000,
      livenessActiveMs: 60_000,
      livenessIdleMs: 20 * 60_000,
      livenessStaleMs: 48 * 60 * 60_000,
    });
  });

  it('rejects invalid thresholds with 400', async () => {
    const response = await createBoardThresholdsRoutes({ store: makeStore() }).request(
      '/api/settings/board-thresholds',
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          livenessActiveMs: DEFAULT_LIVENESS_THRESHOLDS.idleMs,
          version: EMPTY_VERSION,
        }),
      },
      LOCAL_ENV,
    );
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe('invalid board thresholds');
    expect(body.details.errors).toContain(
      'liveness active は liveness idle より短くしてください',
    );
  });

  it('returns 409 on version mismatch', async () => {
    const response = await createBoardThresholdsRoutes({ store: makeStore() }).request(
      '/api/settings/board-thresholds',
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          stalledAfterMs: 12 * 60 * 60_000,
          version: 'stale-version',
        }),
      },
      LOCAL_ENV,
    );
    expect(response.status).toBe(409);
  });

  it('writes wip limit fields and can clear the global limit with null', async () => {
    const store = makePersistedStore({ inProgressWipLimit: 5 });
    const setResponse = await createBoardThresholdsRoutes({ store }).request(
      '/api/settings/board-thresholds',
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          inProgressWipLimit: 7,
          inProgressWipLimitByProject: { 'proj-a': 3 },
          version: computeBoardThresholdsVersion({ inProgressWipLimit: 5 }),
        }),
      },
      LOCAL_ENV,
    );
    expect(setResponse.status).toBe(200);
    expect(store.write).toHaveBeenLastCalledWith({
      inProgressWipLimit: 7,
      inProgressWipLimitByProject: { 'proj-a': 3 },
    });

    const clearResponse = await createBoardThresholdsRoutes({ store }).request(
      '/api/settings/board-thresholds',
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          inProgressWipLimit: null,
          version: computeBoardThresholdsVersion({
            inProgressWipLimit: 7,
            inProgressWipLimitByProject: { 'proj-a': 3 },
          }),
        }),
      },
      LOCAL_ENV,
    );
    expect(clearResponse.status).toBe(200);
    expect(store.write).toHaveBeenLastCalledWith({
      inProgressWipLimitByProject: { 'proj-a': 3 },
    });
  });

  it('rejects a non-local unauthenticated write', async () => {
    const store = makeStore();
    const response = await createBoardThresholdsRoutes({ store }).request(
      '/api/settings/board-thresholds',
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'cf-ray': 'abc' },
        body: JSON.stringify({
          stalledAfterMs: 12 * 60 * 60_000,
          version: EMPTY_VERSION,
        }),
      },
      { incoming: { socket: { remoteAddress: '192.0.2.1' } } },
    );
    expect(response.status).toBe(403);
    expect(store.write).not.toHaveBeenCalled();
  });
});
