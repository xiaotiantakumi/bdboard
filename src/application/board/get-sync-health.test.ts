import { describe, expect, it } from 'vitest';
import type { Project } from '../../domain/project.js';
import type { SyncHealthSignals } from '../../domain/sync-health.js';
import type { SyncHealthReader } from '../ports/sync-health-reader.js';
import { getSyncHealth } from './get-sync-health.js';

function project(id: string, rootPath: string): Project {
  return {
    id,
    name: id,
    rootPath,
    prefixes: ['bdboard'],
    aliasPaths: [],
  };
}

function healthySignals(): SyncHealthSignals {
  return {
    localDoltRefHash: 'abc123',
    localDoltRefCommitMs: 1_700_000_000_000,
    remoteDoltRefHash: 'abc123',
    issuesJsonlMtimeMs: 1_700_000_000_000,
    interactionsUncommitted: false,
  };
}

describe('getSyncHealth', () => {
  it('returns sync health for multiple projects', async () => {
    const reader: SyncHealthReader = {
      readSignals: async (rootPath) => {
        if (rootPath === '/projects/a') {
          return healthySignals();
        }
        return {
          ...healthySignals(),
          remoteDoltRefHash: 'different',
        };
      },
    };

    const results = await getSyncHealth(
      [project('proj-a', '/projects/a'), project('proj-b', '/projects/b')],
      reader,
    );

    expect(results).toHaveLength(2);
    expect(results.find((entry) => entry.projectId === 'proj-a')?.status).toBe('ok');
    expect(results.find((entry) => entry.projectId === 'proj-b')?.status).toBe(
      'attention',
    );
  });

  it('skips projects whose readSignals rejects without failing the whole call', async () => {
    const reader: SyncHealthReader = {
      readSignals: async (rootPath) => {
        if (rootPath === '/projects/b') {
          throw new Error('git read failed');
        }
        return healthySignals();
      },
    };

    const results = await getSyncHealth(
      [project('proj-a', '/projects/a'), project('proj-b', '/projects/b')],
      reader,
    );

    expect(results).toHaveLength(1);
    expect(results[0]?.projectId).toBe('proj-a');
    expect(results[0]?.status).toBe('ok');
  });
});
