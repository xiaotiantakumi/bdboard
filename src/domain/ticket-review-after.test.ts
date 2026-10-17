import { describe, expect, it } from 'vitest';
import { parseTicketReviewAfter } from './ticket-review-after.js';

describe('parseTicketReviewAfter', () => {
  it('parses, trims, and deduplicates ids in order', () => {
    expect(parseTicketReviewAfter({ 'bdboard.review_after': ' A-1, B-2, A-1 ' })).toEqual(['A-1', 'B-2']);
  });
  it('drops empty and invalid ids and returns undefined for an empty result', () => {
    expect(parseTicketReviewAfter({ 'bdboard.review_after': ' , , bad id ' })).toBeUndefined();
    expect(parseTicketReviewAfter({ 'bdboard.review_after': ' A-1, ,B-2 ' })).toEqual(['A-1', 'B-2']);
  });
  it('returns undefined for non-string values', () => {
    expect(parseTicketReviewAfter({ 'bdboard.review_after': 42 })).toBeUndefined();
    expect(parseTicketReviewAfter({ 'bdboard.review_after': null })).toBeUndefined();
  });
});
