import { describe, expect, it } from 'vitest';
import { parseReclaimStdout } from './parse-reclaim-output.js';

describe('parseReclaimStdout', () => {
  it('returns count 0 for empty stdout', () => {
    expect(parseReclaimStdout('')).toEqual({ count: 0, summary: '' });
    expect(parseReclaimStdout('  \n  ')).toEqual({ count: 0, summary: '' });
  });

  it('parses "reclaimed N issue(s)" patterns', () => {
    expect(parseReclaimStdout('reclaimed 2 issues')).toEqual({
      count: 2,
      summary: 'reclaimed 2 issues',
    });
    expect(parseReclaimStdout('3 issues reclaimed')).toEqual({
      count: 3,
      summary: '3 issues reclaimed',
    });
    expect(parseReclaimStdout('Reclaimed 1 issue')).toEqual({
      count: 1,
      summary: 'Reclaimed 1 issue',
    });
  });

  it('returns null count when output is unparseable', () => {
    expect(parseReclaimStdout('done')).toEqual({ count: null, summary: 'done' });
  });
});
