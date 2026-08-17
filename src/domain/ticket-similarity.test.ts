import { describe, expect, it } from 'vitest';
import { makeTicket } from './test-support.js';
import {
  computeTicketSimilarity,
  findSimilarTickets,
} from './ticket-similarity.js';

describe('computeTicketSimilarity', () => {
  it('returns a high score for identical title and description', () => {
    const target = makeTicket({
      id: 'bdboard-target',
      title: 'Similar ticket detection',
      description: 'Show similar tickets in the detail panel',
    });
    const candidate = makeTicket({
      id: 'bdboard-candidate',
      title: 'Similar ticket detection',
      description: 'Show similar tickets in the detail panel',
    });

    expect(computeTicketSimilarity(target, candidate)).toBe(1);
  });

  it('returns a low score for unrelated tickets', () => {
    const target = makeTicket({
      id: 'bdboard-target',
      title: 'Database migration plan',
      description: 'Move issue history to Dolt storage',
    });
    const candidate = makeTicket({
      id: 'bdboard-candidate',
      title: 'Mobile tunnel QR code',
      description: 'Fix Safari credential URL handling',
    });

    expect(computeTicketSimilarity(target, candidate)).toBe(0);
  });

  it('weights title overlap more heavily than description overlap', () => {
    const target = makeTicket({
      id: 'bdboard-target',
      title: 'Similar ticket detection',
      description: 'Unrelated body text',
    });
    const titleMatch = makeTicket({
      id: 'bdboard-title-match',
      title: 'Similar ticket detection',
      description: 'Completely different description body',
    });
    const descriptionMatch = makeTicket({
      id: 'bdboard-description-match',
      title: 'Unrelated title',
      description: 'Unrelated body text',
    });

    expect(
      computeTicketSimilarity(target, titleMatch),
    ).toBeGreaterThan(computeTicketSimilarity(target, descriptionMatch));
  });
});

describe('findSimilarTickets', () => {
  it('excludes the target ticket from results', () => {
    const target = makeTicket({
      id: 'bdboard-target',
      title: 'Similar ticket detection',
      description: 'Detail panel display',
    });
    const other = makeTicket({
      id: 'bdboard-other',
      title: 'Similar ticket detection',
      description: 'Detail panel display',
    });

    const results = findSimilarTickets(target, [target, other]);
    expect(results.map((entry) => entry.ticket.id)).toEqual(['bdboard-other']);
  });

  it('sorts by score descending and ticket id ascending on ties', () => {
    const target = makeTicket({
      id: 'bdboard-target',
      title: 'Similar ticket detection',
      description: 'Detail panel display',
    });
    const high = makeTicket({
      id: 'bdboard-high',
      title: 'Similar ticket detection',
      description: 'Detail panel display',
    });
    const tieA = makeTicket({
      id: 'bdboard-aaa',
      title: 'Similar ticket panel',
      description: 'Detail panel display',
    });
    const tieB = makeTicket({
      id: 'bdboard-bbb',
      title: 'Similar ticket panel',
      description: 'Detail panel display',
    });
    const low = makeTicket({
      id: 'bdboard-low',
      title: 'Unrelated work',
      description: 'Something else entirely',
    });

    const results = findSimilarTickets(target, [high, tieB, tieA, low], {
      minScore: 0,
    });

    expect(results.map((entry) => entry.ticket.id)).toEqual([
      'bdboard-high',
      'bdboard-aaa',
      'bdboard-bbb',
      'bdboard-low',
    ]);
  });

  it('respects limit and minScore boundaries', () => {
    const target = makeTicket({
      id: 'bdboard-target',
      title: 'Similar ticket detection',
      description: 'Detail panel display',
    });
    const candidates = [
      makeTicket({
        id: 'bdboard-one',
        title: 'Similar ticket detection',
        description: 'Detail panel display',
      }),
      makeTicket({
        id: 'bdboard-two',
        title: 'Similar ticket detection',
        description: 'Detail panel display',
      }),
      makeTicket({
        id: 'bdboard-three',
        title: 'Similar ticket panel',
        description: 'Detail panel display',
      }),
      makeTicket({
        id: 'bdboard-four',
        title: 'Unrelated work',
        description: 'Something else entirely',
      }),
    ];

    const limited = findSimilarTickets(target, candidates, { limit: 2 });
    expect(limited).toHaveLength(2);

    const filtered = findSimilarTickets(target, candidates, { minScore: 0.5 });
    expect(filtered.every((entry) => entry.score >= 0.5)).toBe(true);
    expect(filtered.some((entry) => entry.ticket.id === 'bdboard-four')).toBe(false);
  });
});
