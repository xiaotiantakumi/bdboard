import { describe, expect, it } from 'vitest';
import { parseClampedIntQueryParam } from './parse-clamped-int-query-param.js';

const OPTIONS = { min: 1, max: 100, defaultValue: 20 };

describe('parseClampedIntQueryParam', () => {
  it('returns default for undefined or empty string', () => {
    expect(parseClampedIntQueryParam(undefined, OPTIONS)).toBe(20);
    expect(parseClampedIntQueryParam('', OPTIONS)).toBe(20);
  });

  it('returns default for non-finite parse results', () => {
    expect(parseClampedIntQueryParam('abc', OPTIONS)).toBe(20);
    expect(parseClampedIntQueryParam('NaN', OPTIONS)).toBe(20);
  });

  it('clamps parsed integers to min and max', () => {
    expect(parseClampedIntQueryParam('0', OPTIONS)).toBe(1);
    expect(parseClampedIntQueryParam('50', OPTIONS)).toBe(50);
    expect(parseClampedIntQueryParam('999', OPTIONS)).toBe(100);
  });

  it('truncates via parseInt before clamping', () => {
    expect(parseClampedIntQueryParam('3.9', OPTIONS)).toBe(3);
  });
});
