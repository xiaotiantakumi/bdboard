import { describe, expect, it } from 'vitest';
import { checkHygiene } from './hygiene.js';
import { issueKinds, issuesFor, localDate, NOW } from './hygiene-test-support.js';
import { makeTicket } from './test-support.js';

describe('checkHygiene overdue_defer', () => {
  it('flags deferred tickets whose defer_until is in the past', () => {
    const deferUntil = localDate(2026, 5, 20, 9); // NOW(2026-06-01T12:00:00Z)より過去
    const ticket = makeTicket({
      id: 'bdboard-overdue',
      status: 'deferred',
      deferUntil,
    });

    expect(issueKinds([ticket])).toEqual(['overdue_defer']);
    const issue = issuesFor('bdboard-overdue', [ticket])[0];
    expect(issue?.deferUntil).toBe('2026-05-20');
  });

  it('does not flag deferred tickets with future defer_until', () => {
    const ticket = makeTicket({
      id: 'bdboard-future',
      status: 'deferred',
      deferUntil: new Date(NOW.getTime() + 60_000),
    });

    expect(issueKinds([ticket])).toEqual([]);
  });

  it('does not flag when defer_until is unset', () => {
    const ticket = makeTicket({
      id: 'bdboard-no-defer',
      status: 'deferred',
    });

    expect(issueKinds([ticket])).toEqual([]);
  });

  it('does not flag non-deferred tickets even if defer_until is past', () => {
    const ticket = makeTicket({
      id: 'bdboard-open-past',
      status: 'open',
      deferUntil: new Date(NOW.getTime() - 60_000),
    });

    expect(issueKinds([ticket])).toEqual([]);
  });

  it('flags at exactly defer_until boundary', () => {
    const ticket = makeTicket({
      id: 'bdboard-exact',
      status: 'deferred',
      deferUntil: NOW,
    });

    expect(issueKinds([ticket])).toEqual(['overdue_defer']);
  });
});

describe('checkHygiene deferUntil field', () => {
  it('does not set deferUntil on non-overdue_defer kinds', () => {
    const epic = makeTicket({ id: 'bdboard-epic', status: 'open' });
    const child = makeTicket({
      id: 'bdboard-child',
      parentId: 'bdboard-epic',
      status: 'closed',
      closedAt: NOW,
    });
    const issues = checkHygiene([epic, child], { now: NOW });
    for (const issue of issues) {
      expect(issue.deferUntil).toBeUndefined();
    }
  });
});
