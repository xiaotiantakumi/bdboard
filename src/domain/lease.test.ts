import { describe, expect, it } from 'vitest';
import {
  detectStaleLeases,
  hasLeaseExpiry,
  isStaleLease,
  staleLeaseElapsedMs,
} from './lease.js';

const NOW = new Date('2026-08-16T10:00:00.000Z');

describe('hasLeaseExpiry', () => {
  it('returns true when lease_expires_at is a non-empty string', () => {
    expect(
      hasLeaseExpiry({
        leaseExpiresAt: '2026-08-16T09:55:00.000Z',
        heartbeatAt: '2026-08-16T09:50:00.000Z',
      }),
    ).toBe(true);
  });

  it('returns false when lease_expires_at is null or missing', () => {
    expect(hasLeaseExpiry({ leaseExpiresAt: null, heartbeatAt: null })).toBe(false);
    expect(hasLeaseExpiry({ leaseExpiresAt: undefined, heartbeatAt: null })).toBe(false);
    expect(hasLeaseExpiry({ leaseExpiresAt: '', heartbeatAt: null })).toBe(false);
  });
});

describe('isStaleLease', () => {
  it('returns true when lease expired before now', () => {
    expect(isStaleLease('2026-08-16T09:55:00.000Z', NOW)).toBe(true);
  });

  it('returns false when lease is still valid', () => {
    expect(isStaleLease('2026-08-16T10:05:00.000Z', NOW)).toBe(false);
  });

  it('returns false for unparseable timestamps', () => {
    expect(isStaleLease('not-a-date', NOW)).toBe(false);
  });
});

describe('staleLeaseElapsedMs', () => {
  it('returns elapsed ms since expiry', () => {
    expect(staleLeaseElapsedMs('2026-08-16T09:55:00.000Z', NOW)).toBe(5 * 60_000);
  });

  it('returns 0 when lease has not expired yet', () => {
    expect(staleLeaseElapsedMs('2026-08-16T10:05:00.000Z', NOW)).toBe(0);
  });
});

describe('detectStaleLeases', () => {
  it('detects only in_progress tickets with expired lease', () => {
    const issues = detectStaleLeases(
      [
        {
          id: 'bdboard-stale',
          leaseExpiresAt: '2026-08-16T09:55:00.000Z',
          heartbeatAt: '2026-08-16T09:50:00.000Z',
        },
        {
          id: 'bdboard-fresh',
          leaseExpiresAt: '2026-08-16T10:05:00.000Z',
          heartbeatAt: '2026-08-16T10:00:00.000Z',
        },
        {
          id: 'bdboard-no-lease',
          leaseExpiresAt: null,
          heartbeatAt: null,
        },
      ],
      'proj-a',
      NOW,
    );

    expect(issues).toEqual([
      {
        ticketId: 'bdboard-stale',
        projectId: 'proj-a',
        leaseExpiresAt: '2026-08-16T09:55:00.000Z',
        staleForMs: 5 * 60_000,
      },
    ]);
  });
});
