import { describe, expect, it } from 'vitest';
import {
  checkHygiene,
  needsCloseEvidenceLookup,
  pendingDecisionKey,
} from './hygiene.js';
import { NOW } from './hygiene-test-support.js';
import { DEFAULT_HYGIENE_THRESHOLDS } from './hygiene-thresholds.js';
import { makeTicket } from './test-support.js';
import type { Ticket } from './ticket.js';

describe('checkHygiene closed_without_evidence', () => {
  const WINDOW_MS = DEFAULT_HYGIENE_THRESHOLDS.closedWithoutEvidenceWindowMs;

  /** makeTicket の既定 projectId。 */
  const PROJECT = '/projects/bdboard';

  function evidenceKeys(...ids: readonly string[]): Set<string> {
    return new Set(ids.map((id) => pendingDecisionKey(PROJECT, id)));
  }

  function closedWithoutEvidenceIssues(
    tickets: readonly Ticket[],
    options: {
      readonly closeEvidenceKeys?: ReadonlySet<string>;
      readonly closeEvidenceUnknownKeys?: ReadonlySet<string>;
      readonly closeEvidenceAvailable?: boolean;
      readonly thresholds?: typeof DEFAULT_HYGIENE_THRESHOLDS;
    } = {},
  ) {
    return checkHygiene(tickets, {
      now: NOW,
      closeEvidenceKeys: options.closeEvidenceKeys,
      closeEvidenceUnknownKeys: options.closeEvidenceUnknownKeys,
      closeEvidenceAvailable: options.closeEvidenceAvailable,
      thresholds: options.thresholds,
    }).filter((issue) => issue.kind === 'closed_without_evidence');
  }

  it('flags recently closed tickets with no PR or verification record', () => {
    const ticket = makeTicket({
      id: 'bdboard-no-evidence',
      status: 'closed',
      closedAt: new Date(NOW.getTime() - 2 * 86_400_000),
    });

    const issues = closedWithoutEvidenceIssues([ticket]);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      kind: 'closed_without_evidence',
      ticketId: 'bdboard-no-evidence',
      severity: 'info',
      message:
        'close 済みだが PR/検証の記録がない（close-template.md の書式でコメントを残す）',
    });
  });

  it('does not flag when closeEvidenceKeys contains the ticket', () => {
    const ticket = makeTicket({
      id: 'bdboard-with-comment',
      status: 'closed',
      closedAt: new Date(NOW.getTime() - 2 * 86_400_000),
    });

    expect(
      closedWithoutEvidenceIssues([ticket], {
        closeEvidenceKeys: evidenceKeys('bdboard-with-comment'),
      }),
    ).toEqual([]);
  });

  it('does not flag when closeReason contains a PR number reference', () => {
    const ticket = makeTicket({
      id: 'bdboard-reason',
      status: 'closed',
      closedAt: new Date(NOW.getTime() - 2 * 86_400_000),
      closeReason: 'Merged via #123',
    });

    expect(closedWithoutEvidenceIssues([ticket])).toEqual([]);
  });

  it('does not flag epic, gate, or gt:slot tickets', () => {
    const epic = makeTicket({
      id: 'bdboard-epic',
      issueType: 'epic',
      status: 'closed',
      closedAt: new Date(NOW.getTime() - 2 * 86_400_000),
    });
    const gate = makeTicket({
      id: 'bdboard-gate',
      issueType: 'gate',
      status: 'closed',
      closedAt: new Date(NOW.getTime() - 2 * 86_400_000),
    });
    const slot = makeTicket({
      id: 'bdboard-slot',
      status: 'closed',
      closedAt: new Date(NOW.getTime() - 2 * 86_400_000),
      labels: ['gt:slot'],
    });

    expect(closedWithoutEvidenceIssues([epic, gate, slot])).toEqual([]);
  });

  it('does not flag when closedAt is outside the window', () => {
    const ticket = makeTicket({
      id: 'bdboard-old',
      status: 'closed',
      closedAt: new Date(NOW.getTime() - WINDOW_MS - 1),
    });

    expect(closedWithoutEvidenceIssues([ticket])).toEqual([]);
  });

  it('does not flag when closeReason mentions merge', () => {
    const ticket = makeTicket({
      id: 'bdboard-merge',
      status: 'closed',
      closedAt: new Date(NOW.getTime() - 2 * 86_400_000),
      closeReason: 'Squash merge completed',
    });

    expect(closedWithoutEvidenceIssues([ticket])).toEqual([]);
  });

  it('does not flag when closeReason contains マージ', () => {
    const ticket = makeTicket({
      id: 'bdboard-ja-merge',
      status: 'closed',
      closedAt: new Date(NOW.getTime() - 2 * 86_400_000),
      closeReason: 'main にマージ済み',
    });

    expect(closedWithoutEvidenceIssues([ticket])).toEqual([]);
  });

  it('does not flag when closeReason contains PR as a word', () => {
    const ticket = makeTicket({
      id: 'bdboard-pr',
      status: 'closed',
      closedAt: new Date(NOW.getTime() - 2 * 86_400_000),
      closeReason: 'Closed after PR review',
    });

    expect(closedWithoutEvidenceIssues([ticket])).toEqual([]);
  });

  it('flags when closeReason only mentions PR inside another word', () => {
    const ticket = makeTicket({
      id: 'bdboard-prep',
      status: 'closed',
      closedAt: new Date(NOW.getTime() - 2 * 86_400_000),
      closeReason: 'preparation complete',
    });

    expect(closedWithoutEvidenceIssues([ticket])).toHaveLength(1);
  });

  it('does not flag when closedAt is missing or invalid', () => {
    const noClosedAt = makeTicket({
      id: 'bdboard-no-date',
      status: 'closed',
    });
    const invalidClosedAt = makeTicket({
      id: 'bdboard-bad-date',
      status: 'closed',
      closedAt: new Date('not a date'),
    });

    expect(closedWithoutEvidenceIssues([noClosedAt, invalidClosedAt])).toEqual([]);
  });

  it('flags at exactly the window boundary', () => {
    const ticket = makeTicket({
      id: 'bdboard-boundary',
      status: 'closed',
      closedAt: new Date(NOW.getTime() - WINDOW_MS),
    });

    expect(closedWithoutEvidenceIssues([ticket])).toHaveLength(1);
  });

  it('stays quiet one millisecond after the window', () => {
    const ticket = makeTicket({
      id: 'bdboard-just-outside',
      status: 'closed',
      closedAt: new Date(NOW.getTime() - WINDOW_MS - 1),
    });

    expect(closedWithoutEvidenceIssues([ticket])).toEqual([]);
  });

  it('does not flag when closeEvidenceUnknownKeys contains the ticket', () => {
    const ticket = makeTicket({
      id: 'bdboard-unknown',
      status: 'closed',
      closedAt: new Date(NOW.getTime() - 2 * 86_400_000),
      commentCount: 1,
    });

    expect(
      closedWithoutEvidenceIssues([ticket], {
        closeEvidenceUnknownKeys: evidenceKeys('bdboard-unknown'),
      }),
    ).toEqual([]);
  });

  it('does not flag when both unknown and evidence keys contain the ticket', () => {
    const ticket = makeTicket({
      id: 'bdboard-both',
      status: 'closed',
      closedAt: new Date(NOW.getTime() - 2 * 86_400_000),
      commentCount: 1,
    });

    const keys = evidenceKeys('bdboard-both');
    expect(
      closedWithoutEvidenceIssues([ticket], {
        closeEvidenceKeys: keys,
        closeEvidenceUnknownKeys: keys,
      }),
    ).toEqual([]);
  });

  it('does not flag when closeEvidenceAvailable is false (m6)', () => {
    const ticket = makeTicket({
      id: 'bdboard-unavailable',
      status: 'closed',
      closedAt: new Date(NOW.getTime() - 2 * 86_400_000),
    });

    expect(
      closedWithoutEvidenceIssues([ticket], { closeEvidenceAvailable: false }),
    ).toEqual([]);
  });
});

describe('needsCloseEvidenceLookup', () => {
  const WINDOW_MS = DEFAULT_HYGIENE_THRESHOLDS.closedWithoutEvidenceWindowMs;

  function lookup(
    ticket: Ticket,
    now: Date = NOW,
    windowMs: number = WINDOW_MS,
  ): boolean {
    return needsCloseEvidenceLookup(ticket, now, windowMs);
  }

  it('returns true for a closed ticket within window with comments and no closeReason evidence', () => {
    const ticket = makeTicket({
      id: 'bdboard-lookup',
      status: 'closed',
      closedAt: new Date(NOW.getTime() - 2 * 86_400_000),
      commentCount: 1,
    });

    expect(lookup(ticket)).toBe(true);
  });

  it('returns false when status is not closed', () => {
    const ticket = makeTicket({
      id: 'bdboard-open',
      status: 'open',
      closedAt: new Date(NOW.getTime() - 2 * 86_400_000),
      commentCount: 1,
    });

    expect(lookup(ticket)).toBe(false);
  });

  it('returns false when closedAt is outside the window', () => {
    const ticket = makeTicket({
      id: 'bdboard-old',
      status: 'closed',
      closedAt: new Date(NOW.getTime() - WINDOW_MS - 1),
      commentCount: 1,
    });

    expect(lookup(ticket)).toBe(false);
  });

  it('returns false when commentCount is zero', () => {
    const ticket = makeTicket({
      id: 'bdboard-no-comments',
      status: 'closed',
      closedAt: new Date(NOW.getTime() - 2 * 86_400_000),
      commentCount: 0,
    });

    expect(lookup(ticket)).toBe(false);
  });

  it('returns false for epic, gate, or gt:slot tickets', () => {
    const epic = makeTicket({
      id: 'bdboard-epic',
      issueType: 'epic',
      status: 'closed',
      closedAt: new Date(NOW.getTime() - 2 * 86_400_000),
      commentCount: 1,
    });
    const gate = makeTicket({
      id: 'bdboard-gate',
      issueType: 'gate',
      status: 'closed',
      closedAt: new Date(NOW.getTime() - 2 * 86_400_000),
      commentCount: 1,
    });
    const slot = makeTicket({
      id: 'bdboard-slot',
      status: 'closed',
      closedAt: new Date(NOW.getTime() - 2 * 86_400_000),
      commentCount: 1,
      labels: ['gt:slot'],
    });

    expect(lookup(epic)).toBe(false);
    expect(lookup(gate)).toBe(false);
    expect(lookup(slot)).toBe(false);
  });

  it('returns false when closeReason contains a PR number reference', () => {
    const ticket = makeTicket({
      id: 'bdboard-reason',
      status: 'closed',
      closedAt: new Date(NOW.getTime() - 2 * 86_400_000),
      commentCount: 1,
      closeReason: 'Merged via #123',
    });

    expect(lookup(ticket)).toBe(false);
  });
});
