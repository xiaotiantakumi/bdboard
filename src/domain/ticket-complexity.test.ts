import { describe, expect, it } from 'vitest';
import { parseTicketComplexity } from './ticket-complexity.js';

describe('parseTicketComplexity', () => {
  it('returns undefined for undefined metadata', () => {
    expect(parseTicketComplexity(undefined)).toBeUndefined();
  });

  it('returns undefined when bdboard.complexity is absent', () => {
    expect(parseTicketComplexity({ 'bdboard.model.implement': 'composer-2.5' })).toBeUndefined();
  });

  it('returns the trimmed value for known complexities', () => {
    expect(parseTicketComplexity({ 'bdboard.complexity': 'low' })).toBe('low');
    expect(parseTicketComplexity({ 'bdboard.complexity': 'med' })).toBe('med');
    expect(parseTicketComplexity({ 'bdboard.complexity': 'high' })).toBe('high');
  });

  it('trims surrounding whitespace', () => {
    expect(parseTicketComplexity({ 'bdboard.complexity': '  low  ' })).toBe('low');
  });

  it('passes through unrecognized values without validation (display-only)', () => {
    expect(parseTicketComplexity({ 'bdboard.complexity': 'xl' })).toBe('xl');
  });

  it('treats non-string values as absent', () => {
    expect(parseTicketComplexity({ 'bdboard.complexity': 42 })).toBeUndefined();
    expect(parseTicketComplexity({ 'bdboard.complexity': null })).toBeUndefined();
    expect(parseTicketComplexity({ 'bdboard.complexity': true })).toBeUndefined();
  });

  it('treats empty and whitespace-only strings as absent', () => {
    expect(parseTicketComplexity({ 'bdboard.complexity': '' })).toBeUndefined();
    expect(parseTicketComplexity({ 'bdboard.complexity': '   ' })).toBeUndefined();
  });

  it('does not confuse bdboard.complexity.source with bdboard.complexity', () => {
    expect(
      parseTicketComplexity({ 'bdboard.complexity.source': 'human' }),
    ).toBeUndefined();
  });
});
