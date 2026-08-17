import { describe, expect, it } from 'vitest';
import { compareStrings } from '../../domain/compare.js';
import { extractBeadIds } from './extract-bead-ids.js';

describe('extractBeadIds', () => {
  const knownIds = new Set([
    'bdboard-3tw.10',
    'sample-project-86o',
    'epic-haslett-00ae14-7sv.21',
    'bdboard-abc',
    'sample-project-xyz',
    'a.b-1',
    'x+y-2',
    '(z)-3',
  ]);

  it('extracts hierarchical id bdboard-3tw.10', () => {
    const result = extractBeadIds(
      'working on bdboard-3tw.10 now',
      ['bdboard'],
      knownIds,
    );
    expect(result).toEqual(['bdboard-3tw.10']);
  });

  it('extracts dash-containing prefix sample-project-86o', () => {
    const result = extractBeadIds(
      'see sample-project-86o in transcript',
      ['sample-project'],
      knownIds,
    );
    expect(result).toEqual(['sample-project-86o']);
  });

  it('extracts epic-haslett-00ae14-7sv.21', () => {
    const result = extractBeadIds(
      'linked epic-haslett-00ae14-7sv.21',
      ['epic-haslett-00ae14'],
      knownIds,
    );
    expect(result).toEqual(['epic-haslett-00ae14-7sv.21']);
  });

  it('drops ids not present in knownIds', () => {
    const result = extractBeadIds(
      'bdboard-zzz and bdboard-abc',
      ['bdboard'],
      knownIds,
    );
    expect(result).toEqual(['bdboard-abc']);
  });

  it('prefers longer prefixes over shorter ones', () => {
    const result = extractBeadIds(
      'ticket sample-project-86o',
      ['own', 'sample-project'],
      knownIds,
    );
    expect(result).toEqual(['sample-project-86o']);
    expect(result).not.toContain('own-news');
  });

  it('treats regex-special prefixes literally', () => {
    const specialIds = new Set(['a.b-1', 'x+y-2', '(z)-3']);
    const result = extractBeadIds(
      'refs a.b-1 x+y-2 (z)-3',
      ['a.b', 'x+y', '(z)'],
      specialIds,
    );
    expect(result).toEqual(['(z)-3', 'a.b-1', 'x+y-2']);
  });

  it('deduplicates repeated ids', () => {
    const result = extractBeadIds(
      'bdboard-abc bdboard-abc again bdboard-abc',
      ['bdboard'],
      knownIds,
    );
    expect(result).toEqual(['bdboard-abc']);
  });

  it('returns empty array for empty text or empty prefixes', () => {
    expect(extractBeadIds('', ['bdboard'], knownIds)).toEqual([]);
    expect(extractBeadIds('bdboard-abc', [], knownIds)).toEqual([]);
    expect(extractBeadIds('bdboard-abc', [''], knownIds)).toEqual([]);
    expect(extractBeadIds('bdboard-abc', ['bdboard'], new Set())).toEqual([]);
  });

  it('returns results in ascending order', () => {
    const ids = new Set(['bdboard-aaa', 'bdboard-bbb', 'bdboard-ccc']);
    const result = extractBeadIds(
      'bdboard-ccc bdboard-aaa bdboard-bbb',
      ['bdboard'],
      ids,
    );
    const sorted = [...result].sort(compareStrings);
    expect(result).toEqual(sorted);
    expect(result).toEqual(['bdboard-aaa', 'bdboard-bbb', 'bdboard-ccc']);
  });
});
