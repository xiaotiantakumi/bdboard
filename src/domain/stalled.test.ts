import { describe, expect, it } from 'vitest';
import {
  DEFAULT_STALLED_THRESHOLDS,
  isStalled,
} from './stalled.js';
import { makeTicket } from './test-support.js';
import type { Ticket } from './ticket.js';

const NOW = new Date('2026-06-01T12:00:00.000Z');
// Derived from the constant so a future change to the default does not silently
// leave these cases testing a threshold the code no longer uses.
const THRESHOLD_MS = DEFAULT_STALLED_THRESHOLDS.stalledAfterMs;
const STALLED_UPDATED_AT = new Date(NOW.getTime() - THRESHOLD_MS);
const ALMOST_STALLED_UPDATED_AT = new Date(NOW.getTime() - THRESHOLD_MS + 1);

function stalledCtx(
  overrides: Partial<{
    now: Date;
    hasActiveSession: boolean;
    thresholds: { stalledAfterMs: number };
  }> = {},
) {
  return {
    now: NOW,
    hasActiveSession: false,
    ...overrides,
  };
}

describe('isStalled', () => {
  it('is false when only status is in_progress', () => {
    const ticket = makeTicket({
      status: 'in_progress',
      updatedAt: NOW,
    });

    expect(
      isStalled(ticket, stalledCtx({ hasActiveSession: true })),
    ).toBe(false);
  });

  it('is false when only hasActiveSession is false', () => {
    // Genuinely isolates condition 2: the status is wrong AND the ticket was
    // just updated, so nothing but the missing session could make it stall.
    const ticket = makeTicket({
      status: 'open',
      updatedAt: NOW,
    });

    expect(isStalled(ticket, stalledCtx())).toBe(false);
  });

  it('is false for an in_progress ticket updated moments ago with no session', () => {
    // The case that matters in practice: work paused for a coffee break must not
    // be reported as stalled just because no session is running right now.
    const ticket = makeTicket({
      status: 'in_progress',
      updatedAt: NOW,
    });

    expect(isStalled(ticket, stalledCtx())).toBe(false);
  });

  it('is false when only updatedAt is old enough', () => {
    const ticket = makeTicket({
      status: 'open',
      updatedAt: STALLED_UPDATED_AT,
    });

    expect(
      isStalled(ticket, stalledCtx({ hasActiveSession: true })),
    ).toBe(false);
  });

  it('is true when all three conditions are met', () => {
    const ticket = makeTicket({
      status: 'in_progress',
      updatedAt: STALLED_UPDATED_AT,
    });

    expect(isStalled(ticket, stalledCtx())).toBe(true);
  });

  it('is false when updatedAt is missing at runtime', () => {
    const ticket = {
      ...makeTicket({ status: 'in_progress' }),
      updatedAt: undefined as unknown as Date,
    } satisfies Ticket;

    expect(isStalled(ticket, stalledCtx())).toBe(false);
  });

  it('is false when updatedAt is not a Date at runtime', () => {
    const ticket = {
      ...makeTicket({ status: 'in_progress' }),
      updatedAt: '2020-01-01T00:00:00.000Z' as unknown as Date,
    } satisfies Ticket;

    expect(isStalled(ticket, stalledCtx())).toBe(false);
  });

  it('is false when updatedAt is Invalid Date', () => {
    const ticket = makeTicket({
      status: 'in_progress',
      updatedAt: new Date('not-a-date'),
    });

    expect(isStalled(ticket, stalledCtx())).toBe(false);
  });

  it('is true at exactly the default 48-hour threshold', () => {
    const ticket = makeTicket({
      status: 'in_progress',
      updatedAt: STALLED_UPDATED_AT,
    });

    expect(isStalled(ticket, stalledCtx())).toBe(true);
  });

  it('is false one millisecond before the threshold', () => {
    const ticket = makeTicket({
      status: 'in_progress',
      updatedAt: ALMOST_STALLED_UPDATED_AT,
    });

    expect(isStalled(ticket, stalledCtx())).toBe(false);
  });

  it('respects custom thresholds', () => {
    const ticket = makeTicket({
      status: 'in_progress',
      updatedAt: new Date(NOW.getTime() - 60 * 60_000),
    });

    expect(
      isStalled(
        ticket,
        stalledCtx({
          thresholds: { stalledAfterMs: 30 * 60_000 },
        }),
      ),
    ).toBe(true);

    expect(
      isStalled(
        ticket,
        stalledCtx({
          thresholds: { stalledAfterMs: 2 * 60 * 60_000 },
        }),
      ),
    ).toBe(false);
  });

  it('defaults to a full day without an update', () => {
    // Pinned deliberately: real data showed 48h never fired -- the oldest
    // in_progress ticket was 41h -- while the tickets the user actually treated
    // as stalled sat between 24h and 41h.
    expect(DEFAULT_STALLED_THRESHOLDS.stalledAfterMs).toBe(24 * 60 * 60_000);
  });
});
