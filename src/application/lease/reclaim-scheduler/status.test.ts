import { describe, expect, it } from 'vitest';
import { ensureProjectStatus, toProjectStatusSnapshot } from './status.js';
import type { MutableProjectStatus } from './types.js';

describe('ensureProjectStatus', () => {
  it('creates and stores a status with initial values for an unregistered project', () => {
    const statusByProjectId = new Map<string, MutableProjectStatus>();

    const result = ensureProjectStatus(statusByProjectId, 'project-a');

    expect(result).toEqual({
      projectId: 'project-a',
      lastRunAt: null,
      reclaimedCount: null,
      reclaimedCountUnknown: false,
      rawSummary: null,
      lastError: null,
    });
    expect(statusByProjectId.get('project-a')).toBe(result);
  });

  it('returns the existing entry and preserves its updated fields', () => {
    const existing: MutableProjectStatus = {
      projectId: 'project-a',
      lastRunAt: null,
      reclaimedCount: 2,
      reclaimedCountUnknown: false,
      rawSummary: 'completed',
      lastError: null,
    };
    const statusByProjectId = new Map([['project-a', existing]]);
    existing.reclaimedCount = 7;

    const result = ensureProjectStatus(statusByProjectId, 'project-a');

    expect(result).toBe(existing);
    expect(result.reclaimedCount).toBe(7);
  });
});

describe('toProjectStatusSnapshot', () => {
  it('converts the date to ISO and copies the other fields', () => {
    const entry: MutableProjectStatus = {
      projectId: 'project-a',
      lastRunAt: new Date('2026-09-24T12:34:56.000Z'),
      reclaimedCount: 4,
      reclaimedCountUnknown: true,
      rawSummary: 'summary',
      lastError: 'failure',
    };

    expect(toProjectStatusSnapshot(entry)).toEqual({
      projectId: 'project-a',
      lastRunAt: '2026-09-24T12:34:56.000Z',
      reclaimedCount: 4,
      reclaimedCountUnknown: true,
      rawSummary: 'summary',
      lastError: 'failure',
    });
  });

  it('keeps a null lastRunAt as null', () => {
    const entry: MutableProjectStatus = {
      projectId: 'project-a',
      lastRunAt: null,
      reclaimedCount: null,
      reclaimedCountUnknown: false,
      rawSummary: null,
      lastError: null,
    };

    expect(toProjectStatusSnapshot(entry).lastRunAt).toBeNull();
  });
});
