import { describe, expect, it } from 'vitest';
import { makeTicket } from '../../domain/test-support.js';
import type { Ticket } from '../../domain/ticket.js';
import { countComplexityModelRows } from './complexity-model-stats.js';
import type { FixPushLookup, FixPushLookupResult } from './fix-push-lookup-types.js';

const CLOSED_AT = new Date('2026-09-20T10:00:00.000Z');

function closed(id: string, overrides: Partial<Ticket> = {}): Ticket {
  return makeTicket({ id, closedAt: CLOSED_AT, ...overrides });
}

function lookupFrom(results: Record<string, FixPushLookupResult>): FixPushLookup {
  return (ticket) => results[ticket.id] ?? { kind: 'unknown', pending: true };
}

describe('countComplexityModelRows (bdboard-p5l.27)', () => {
  it('joins complexity x implement model x fix push count into one row per pair', async () => {
    const tickets = [
      closed('a', { complexity: 'low', models: [{ stage: 'implement', model: 'm1' }] }),
      closed('b', { complexity: 'low', models: [{ stage: 'implement', model: 'm1' }] }),
      closed('c', { complexity: 'high', models: [{ stage: 'implement', model: 'm1' }] }),
    ];
    const lookup = lookupFrom({
      a: { kind: 'known', count: 0 },
      b: { kind: 'known', count: 3 },
      c: { kind: 'known', count: 5 },
    });

    const stats = await countComplexityModelRows(tickets, lookup);

    expect(stats.rows).toEqual([
      {
        complexity: 'low',
        model: 'm1',
        ticketCount: 2,
        fixPushKnownCount: 2,
        fixPushTotal: 3,
        fixPushUnknownCount: 0,
        fixPushAverage: 1.5,
      },
      {
        complexity: 'high',
        model: 'm1',
        ticketCount: 1,
        fixPushKnownCount: 1,
        fixPushTotal: 5,
        fixPushUnknownCount: 0,
        fixPushAverage: 5,
      },
    ]);
    expect(stats.fixPushPendingCount).toBe(0);
    expect(stats.unrecordedTicketCount).toBe(0);
  });

  it('keeps a ticket with a zero fix push count as known (0 is not unknown)', async () => {
    const stats = await countComplexityModelRows(
      [closed('a', { complexity: 'med', models: [{ stage: 'implement', model: 'm1' }] })],
      lookupFrom({ a: { kind: 'known', count: 0 } }),
    );

    expect(stats.rows[0]).toMatchObject({
      fixPushKnownCount: 1,
      fixPushTotal: 0,
      fixPushUnknownCount: 0,
      fixPushAverage: 0,
    });
  });

  it('treats a ticket without bdboard.complexity as the unrecorded complexity row (not dropped)', async () => {
    const stats = await countComplexityModelRows(
      [closed('a', { models: [{ stage: 'implement', model: 'm1' }] })],
      lookupFrom({ a: { kind: 'known', count: 2 } }),
    );

    expect(stats.rows).toEqual([
      expect.objectContaining({ complexity: null, model: 'm1', ticketCount: 1, fixPushTotal: 2 }),
    ]);
  });

  it('treats a ticket without bdboard.model.implement as the unrecorded model row (not dropped)', async () => {
    const stats = await countComplexityModelRows(
      [
        // implement 以外の工程のモデルだけでは「実装モデル」は記録されたことにならない。
        closed('a', { complexity: 'low', models: [{ stage: 'review', model: 'reviewer' }] }),
        closed('b', { complexity: 'low' }),
      ],
      lookupFrom({ a: { kind: 'known', count: 1 }, b: { kind: 'known', count: 2 } }),
    );

    expect(stats.rows).toEqual([
      expect.objectContaining({
        complexity: 'low',
        model: null,
        ticketCount: 2,
        fixPushTotal: 3,
        fixPushAverage: 1.5,
      }),
    ]);
  });

  it('counts tickets with neither metadata only in unrecordedTicketCount, never looking them up', async () => {
    const looked: string[] = [];
    const stats = await countComplexityModelRows(
      [
        closed('none-1'),
        closed('none-2', { models: [{ stage: 'review', model: 'reviewer' }] }),
        closed('both', { complexity: 'low', models: [{ stage: 'implement', model: 'm1' }] }),
      ],
      (ticket) => {
        looked.push(ticket.id);
        return { kind: 'known', count: 1 };
      },
    );

    expect(stats.unrecordedTicketCount).toBe(2);
    expect(stats.rows).toHaveLength(1);
    expect(looked).toEqual(['both']);
  });

  it('ignores tickets that are not closed', async () => {
    const stats = await countComplexityModelRows(
      [
        makeTicket({
          id: 'open',
          complexity: 'low',
          models: [{ stage: 'implement', model: 'm1' }],
        }),
        makeTicket({ id: 'open-unrecorded' }),
      ],
      lookupFrom({}),
    );

    expect(stats.rows).toEqual([]);
    expect(stats.unrecordedTicketCount).toBe(0);
  });

  it('counts unknown lookups as unknown (kept in the row) and reports the pending ones separately', async () => {
    const tickets = [
      closed('known', { complexity: 'low', models: [{ stage: 'implement', model: 'm1' }] }),
      closed('no-pr', { complexity: 'low', models: [{ stage: 'implement', model: 'm1' }] }),
      closed('pending', { complexity: 'low', models: [{ stage: 'implement', model: 'm1' }] }),
    ];
    const stats = await countComplexityModelRows(
      tickets,
      lookupFrom({
        known: { kind: 'known', count: 4 },
        'no-pr': { kind: 'unknown', pending: false },
        pending: { kind: 'unknown', pending: true },
      }),
    );

    expect(stats.rows).toEqual([
      {
        complexity: 'low',
        model: 'm1',
        ticketCount: 3,
        fixPushKnownCount: 1,
        fixPushTotal: 4,
        fixPushUnknownCount: 2,
        fixPushAverage: 4,
      },
    ]);
    expect(stats.fixPushPendingCount).toBe(1);
  });

  it('reports a null average when no ticket in the row has a known count', async () => {
    const stats = await countComplexityModelRows(
      [closed('a', { complexity: 'low', models: [{ stage: 'implement', model: 'm1' }] })],
      lookupFrom({ a: { kind: 'unknown', pending: false } }),
    );

    expect(stats.rows[0]).toMatchObject({
      ticketCount: 1,
      fixPushKnownCount: 0,
      fixPushUnknownCount: 1,
      fixPushAverage: null,
    });
  });

  it('keeps rows and counts everything as unknown (not pending) when no lookup is provided', async () => {
    const stats = await countComplexityModelRows([
      closed('a', { complexity: 'low', models: [{ stage: 'implement', model: 'm1' }] }),
    ]);

    expect(stats.rows[0]).toMatchObject({
      ticketCount: 1,
      fixPushKnownCount: 0,
      fixPushUnknownCount: 1,
    });
    expect(stats.fixPushPendingCount).toBe(0);
  });

  it('orders rows low -> med -> high, other complexities alphabetically, unrecorded last; models alphabetical with unrecorded last', async () => {
    const tickets = [
      closed('1', { models: [{ stage: 'implement', model: 'zeta' }] }),
      closed('2', { complexity: 'zzz', models: [{ stage: 'implement', model: 'a' }] }),
      closed('3', { complexity: 'high', models: [{ stage: 'implement', model: 'a' }] }),
      closed('4', { complexity: 'low' }),
      closed('5', { complexity: 'low', models: [{ stage: 'implement', model: 'b' }] }),
      closed('6', { complexity: 'aaa', models: [{ stage: 'implement', model: 'a' }] }),
      closed('7', { complexity: 'med', models: [{ stage: 'implement', model: 'a' }] }),
      closed('8', { complexity: 'low', models: [{ stage: 'implement', model: 'a' }] }),
    ];

    const stats = await countComplexityModelRows(tickets);

    expect(stats.rows.map((row) => [row.complexity, row.model])).toEqual([
      ['low', 'a'],
      ['low', 'b'],
      ['low', null],
      ['med', 'a'],
      ['high', 'a'],
      ['aaa', 'a'],
      ['zzz', 'a'],
      [null, 'zeta'],
    ]);
  });

  it('does not mix up a null complexity with a null model in the grouping key', async () => {
    const stats = await countComplexityModelRows([
      closed('a', { complexity: 'low' }),
      closed('b', { models: [{ stage: 'implement', model: 'm1' }] }),
    ]);

    expect(stats.rows.map((row) => [row.complexity, row.model])).toEqual([
      ['low', null],
      [null, 'm1'],
    ]);
  });
});
