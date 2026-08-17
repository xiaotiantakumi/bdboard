import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SYNC_HEALTH_THRESHOLDS,
  evaluateSyncHealth,
  type SyncHealthSignals,
} from './sync-health.js';

const THRESHOLD_MS = DEFAULT_SYNC_HEALTH_THRESHOLDS.staleExportAfterMs;

function healthySignals(
  overrides: Partial<SyncHealthSignals> = {},
): SyncHealthSignals {
  return {
    localDoltRefHash: 'abc123',
    localDoltRefCommitMs: 1_700_000_000_000,
    remoteDoltRefHash: 'abc123',
    issuesJsonlMtimeMs: 1_700_000_000_000,
    interactionsUncommitted: false,
    ...overrides,
  };
}

describe('evaluateSyncHealth', () => {
  it('returns ok with empty reasons when all signals are healthy', () => {
    const result = evaluateSyncHealth('proj-a', healthySignals());

    expect(result).toEqual({
      projectId: 'proj-a',
      status: 'ok',
      reasons: [],
    });
  });

  it('returns unknown with no_dolt_ref when localDoltRefHash is null', () => {
    const result = evaluateSyncHealth(
      'proj-a',
      healthySignals({ localDoltRefHash: null }),
    );

    expect(result.status).toBe('unknown');
    expect(result.reasons).toEqual([
      {
        kind: 'no_dolt_ref',
        message: 'refs/dolt/data がローカルに見つかりません',
      },
    ]);
  });

  it('flags diverged_from_remote when local and remote hashes differ', () => {
    const result = evaluateSyncHealth(
      'proj-a',
      healthySignals({ remoteDoltRefHash: 'def456' }),
    );

    expect(result.status).toBe('attention');
    expect(result.reasons.map((r) => r.kind)).toContain('diverged_from_remote');
  });

  it('does not flag divergence when remoteDoltRefHash is null', () => {
    const result = evaluateSyncHealth(
      'proj-a',
      healthySignals({ remoteDoltRefHash: null }),
    );

    expect(result.status).toBe('ok');
    expect(result.reasons).toEqual([]);
  });

  it('flags stale_export when commit ms exceeds issues mtime by threshold', () => {
    const commitMs = 1_700_000_000_000;
    const result = evaluateSyncHealth(
      'proj-a',
      healthySignals({
        localDoltRefCommitMs: commitMs,
        issuesJsonlMtimeMs: commitMs - THRESHOLD_MS - 1,
      }),
    );

    expect(result.status).toBe('attention');
    expect(result.reasons.map((r) => r.kind)).toContain('stale_export');
  });

  it('does not flag stale_export when mtime gap is below threshold', () => {
    const commitMs = 1_700_000_000_000;
    const result = evaluateSyncHealth(
      'proj-a',
      healthySignals({
        localDoltRefCommitMs: commitMs,
        issuesJsonlMtimeMs: commitMs - THRESHOLD_MS,
      }),
    );

    expect(result.reasons.map((r) => r.kind)).not.toContain('stale_export');
  });

  it('flags uncommitted_interactions when interactionsUncommitted is true', () => {
    const result = evaluateSyncHealth(
      'proj-a',
      healthySignals({ interactionsUncommitted: true }),
    );

    expect(result.status).toBe('attention');
    expect(result.reasons.map((r) => r.kind)).toContain('uncommitted_interactions');
  });

  it('accumulates multiple reasons simultaneously', () => {
    const commitMs = 1_700_000_000_000;
    const result = evaluateSyncHealth(
      'proj-a',
      healthySignals({
        remoteDoltRefHash: 'other-hash',
        localDoltRefCommitMs: commitMs,
        issuesJsonlMtimeMs: commitMs - THRESHOLD_MS - 1,
        interactionsUncommitted: true,
      }),
    );

    expect(result.status).toBe('attention');
    expect(result.reasons.map((r) => r.kind).sort()).toEqual([
      'diverged_from_remote',
      'stale_export',
      'uncommitted_interactions',
    ]);
  });
});
