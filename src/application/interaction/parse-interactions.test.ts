import { describe, expect, it } from 'vitest';
import { parseInteractions } from './parse-interactions.js';

function fieldChangeLine(
  overrides: {
    id?: string;
    kind?: string;
    created_at?: string;
    actor?: string;
    issue_id?: string;
    extra?: Record<string, string>;
  } = {},
): string {
  const row = {
    id: overrides.id ?? 'int-abc123',
    kind: overrides.kind ?? 'field_change',
    created_at: overrides.created_at ?? '2026-08-14T19:28:00.646456Z',
    actor: overrides.actor ?? 'example-agent',
    issue_id: overrides.issue_id ?? 'bdboard-fake-01',
    extra: overrides.extra ?? {
      field: 'status',
      old_value: 'in_progress',
      new_value: 'closed',
      reason: 'example completion reason',
    },
  };
  return JSON.stringify(row);
}

describe('parseInteractions', () => {
  it('parses a valid field_change line with reason', () => {
    const text = fieldChangeLine();
    const records = parseInteractions(text);

    expect(records).toEqual([
      {
        id: 'int-abc123',
        at: new Date('2026-08-14T19:28:00.646456Z'),
        actor: 'example-agent',
        ticketId: 'bdboard-fake-01',
        field: 'status',
        oldValue: 'in_progress',
        newValue: 'closed',
        reason: 'example completion reason',
      },
    ]);
  });

  it('parses a field_change line without reason', () => {
    const text = fieldChangeLine({
      extra: {
        field: 'priority',
        old_value: '2',
        new_value: '1',
      },
    });
    const records = parseInteractions(text);

    expect(records).toEqual([
      {
        id: 'int-abc123',
        at: new Date('2026-08-14T19:28:00.646456Z'),
        actor: 'example-agent',
        ticketId: 'bdboard-fake-01',
        field: 'priority',
        oldValue: '2',
        newValue: '1',
      },
    ]);
  });

  it('skips broken JSON lines without throwing', () => {
    const text = `${fieldChangeLine()}\n{not json}\n`;
    const records = parseInteractions(text);

    expect(records).toHaveLength(1);
    expect(records[0]?.ticketId).toBe('bdboard-fake-01');
  });

  it('skips unknown kind lines without throwing', () => {
    const text = `${fieldChangeLine()}\n${fieldChangeLine({ kind: 'comment_added' })}\n`;
    const records = parseInteractions(text);

    expect(records).toHaveLength(1);
  });

  it('skips lines missing required fields without throwing', () => {
    const text = `${fieldChangeLine()}\n${JSON.stringify({ id: 'int-x', kind: 'field_change' })}\n`;
    const records = parseInteractions(text);

    expect(records).toHaveLength(1);
  });

  it('skips empty and whitespace-only lines', () => {
    const text = `\n  \n${fieldChangeLine()}\n   \n`;
    const records = parseInteractions(text);

    expect(records).toHaveLength(1);
  });

  it('skips lines with invalid created_at without throwing', () => {
    const text = fieldChangeLine({ created_at: 'not-a-date' });
    const records = parseInteractions(text);

    expect(records).toEqual([]);
  });

  it('never throws on hostile input', () => {
    expect(() => parseInteractions('')).not.toThrow();
    expect(() => parseInteractions('{{{[[[')).not.toThrow();
  });
});
