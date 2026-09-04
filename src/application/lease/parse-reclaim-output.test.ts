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
    const parsed = parseReclaimStdout(['bdboard-a', 'bdboard-b', 'bdboard-a'].join('\n'));
    expect(parsed.ticketIds).toEqual(['bdboard-a', 'bdboard-b']);
  });

  it('parses the real bd 1.2.1 reclaim output without picking up noise', () => {
    // 実出力そのまま。見出し行の `stale-lease` と括弧内の担当者名を拾わないこと。
    const stdout = [
      '✓ Reclaimed 2 stale-lease issue(s):',
      '  bd-reclaim-probe-37y (was held by Takumi Oda)',
      '  bd-reclaim-probe-slm (was held by Takumi Oda)',
    ].join('\n');

    const parsed = parseReclaimStdout(stdout);
    expect(parsed.count).toBe(2);
    expect(parsed.ticketIds).toEqual(['bd-reclaim-probe-37y', 'bd-reclaim-probe-slm']);
  });

  it('keeps a hyphenated-prefix id and ignores the holder name after it', () => {
    const parsed = parseReclaimStdout('  bdboard-merge-slot (was held by agent-x)');
    expect(parsed.ticketIds).toEqual(['bdboard-merge-slot']);
  });

  it('reads the real bd 1.2.1 idle output as zero, not as unparseable', () => {
    // count=null にすると 5 分ごとの空振りが「件数不明の発火」として履歴に積まれる。
    expect(parseReclaimStdout('✓ No stale leases to reclaim')).toEqual({
      count: 0,
      summary: '✓ No stale leases to reclaim',
      ticketIds: [],
    });
  });

  it('does not pick up command flags as ids', () => {
    const parsed = parseReclaimStdout('reclaim --older-than 10m --any-replica: nothing to do');
    expect(parsed.ticketIds).toEqual([]);
  });
});
