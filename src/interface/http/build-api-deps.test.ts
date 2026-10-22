import { describe, expect, it } from 'vitest';
import type { BoardThresholdsConfigPort } from '../../application/ports/board-thresholds-config.js';
import {
  createEmptyCacheStatsMethods,
  createEmptyInteractionsCacheMethods,
  createEmptySessionLinksCacheMethods,
} from '../../application/ports/board-cache-fakes.js';
import type { BoardCache } from '../../application/ports/board-cache.js';
import { DEFAULT_LIVENESS_THRESHOLDS } from '../../domain/liveness.js';
import { DEFAULT_STALLED_THRESHOLDS } from '../../domain/stalled.js';
import { createEventHub } from '../sse/event-hub.js';
import { buildApiDeps } from './build-api-deps.js';
import type { ApiStatus } from './routes.js';

function createMinimalBoardCache(): BoardCache {
  return {
    getProject: () => undefined,
    putProject: () => {},
    listProjects: () => [],
    deleteProject: () => {},
    clear: () => {},
    getTranscriptOffset: () => undefined,
    setTranscriptOffset: () => {},
    addSessionUsage: () => {},
    getSessionUsage: () => [],
    ...createEmptyCacheStatsMethods(),
    ...createEmptySessionLinksCacheMethods(),
    ...createEmptyInteractionsCacheMethods(),
    close: () => {},
  };
}

function createMinimalStatus(): ApiStatus {
  return {
    lastRefreshAt: null,
    errors: [],
    projectCount: 0,
  };
}

function createMinimalParams(
  overrides: {
    readonly boardThresholdsConfigStore?: BoardThresholdsConfigPort;
  } = {},
) {
  return {
    cache: createMinimalBoardCache(),
    applicationVersion: { getVersion: () => 'test' },
    now: () => new Date('2026-06-01T12:00:00.000Z'),
    getStatus: () => createMinimalStatus(),
    refresh: async () => {},
    events: createEventHub(),
    boardThresholdsConfigStore: overrides.boardThresholdsConfigStore ?? {
      read: async () => undefined,
      write: async () => {},
    },
  };
}

describe('buildApiDeps', () => {
  it('wires getBoardThresholds from the board thresholds config store', async () => {
    const deps = buildApiDeps(
      createMinimalParams({
        boardThresholdsConfigStore: {
          read: async () => ({ stalledAfterMs: 12_345 }),
          write: async () => {},
        },
      }),
    );

    expect(deps.getBoardThresholds).toBeDefined();
    await expect(deps.getBoardThresholds!()).resolves.toEqual({
      stalledThresholds: { stalledAfterMs: 12_345 },
      livenessThresholds: DEFAULT_LIVENESS_THRESHOLDS,
    });
  });

  it('falls back to defaults when config stores return undefined', async () => {
    const deps = buildApiDeps(createMinimalParams());

    await expect(deps.getBoardThresholds!()).resolves.toEqual({
      stalledThresholds: DEFAULT_STALLED_THRESHOLDS,
      livenessThresholds: DEFAULT_LIVENESS_THRESHOLDS,
    });
  });
});
