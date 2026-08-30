import { describe, expect, it } from 'vitest';
import { truncate } from './text.js';

describe('truncate', () => {
  it('returns text unchanged when length is less than maxLength', () => {
    expect(truncate('hello', 10)).toBe('hello');
  });

  it('returns text unchanged when length equals maxLength', () => {
    expect(truncate('hello', 5)).toBe('hello');
  });

  it('keeps only the first maxLength characters when text is longer', () => {
    expect(truncate('hello world', 5)).toBe('hello');
  });

  it('returns an empty string when maxLength is 0', () => {
    expect(truncate('hello', 0)).toBe('');
  });

  it('returns an empty string for empty input', () => {
    expect(truncate('', 5)).toBe('');
    expect(truncate('', 0)).toBe('');
  });
});
