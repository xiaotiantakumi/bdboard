import { describe, expect, it } from 'vitest';
import { parseReclaimStdout } from './parse-reclaim-output.js';

describe('parseReclaimStdout', () => {
  it('returns count 0 for empty stdout', () => {
    expect(parseReclaimStdout('')).toEqual({ count: 0, summary: '', ticketIds: [] });
    expect(parseReclaimStdout('  \n  ')).toEqual({ count: 0, summary: '', ticketIds: [] });
  });

  it('parses "reclaimed N issue(s)" patterns', () => {
    expect(parseReclaimStdout('reclaimed 2 issues')).toEqual({
      count: 2,
      summary: 'reclaimed 2 issues',
      ticketIds: [],
    });
    expect(parseReclaimStdout('3 issues reclaimed')).toEqual({
      count: 3,
      summary: '3 issues reclaimed',
      ticketIds: [],
    });
    expect(parseReclaimStdout('Reclaimed 1 issue')).toEqual({
      count: 1,
      summary: 'Reclaimed 1 issue',
      ticketIds: [],
    });
  });

  it('returns null count when output is unparseable', () => {
    expect(parseReclaimStdout('done')).toEqual({
      count: null,
      summary: 'done',
      ticketIds: [],
    });
  });

  it('extracts reclaimed ticket ids from listed lines', () => {
    const stdout = [
      'Reclaimed 2 issues:',
      '  bdboard-pkr6.9  (assignee cleared)',
      '  bdboard-abc',
    ].join('\n');

    const parsed = parseReclaimStdout(stdout);
    expect(parsed.count).toBe(2);
    expect(parsed.ticketIds).toEqual(['bdboard-pkr6.9', 'bdboard-abc']);
  });

  it('deduplicates repeated ids and keeps first-seen order', () => {
    const parsed = parseReclaimStdout('bdboard-a bdboard-b bdboard-a');
    expect(parsed.ticketIds).toEqual(['bdboard-a', 'bdboard-b']);
  });

  it('does not pick up command flags as ids', () => {
    const parsed = parseReclaimStdout('reclaim --older-than 10m --any-replica: nothing to do');
    expect(parsed.ticketIds).toEqual([]);
  });
});
