import { describe, expect, it } from 'vitest';
import { idsInInclusiveRange } from './BulkSelectionProvider';

describe('idsInInclusiveRange', () => {
  const ordered = ['a', 'b', 'c', 'd'];

  it('returns inclusive range in forward order', () => {
    expect(idsInInclusiveRange(ordered, 'a', 'c')).toEqual(['a', 'b', 'c']);
  });

  it('returns inclusive range when from is after to', () => {
    expect(idsInInclusiveRange(ordered, 'c', 'a')).toEqual(['a', 'b', 'c']);
  });

  it('returns a single id when from and to match', () => {
    expect(idsInInclusiveRange(ordered, 'b', 'b')).toEqual(['b']);
  });

  it('returns empty when an endpoint is missing', () => {
    expect(idsInInclusiveRange(ordered, 'a', 'missing')).toEqual([]);
  });
});
