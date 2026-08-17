import { describe, expect, it } from 'vitest';
import { isProjectPrefix } from './project.js';

describe('isProjectPrefix', () => {
  it('accepts non-empty prefixes without whitespace that do not end with dash', () => {
    expect(isProjectPrefix('bdboard')).toBe(true);
    expect(isProjectPrefix('sample-project')).toBe(true);
    expect(isProjectPrefix('ExampleApp')).toBe(true);
  });

  it('rejects empty, whitespace-containing, or dash-ending prefixes', () => {
    expect(isProjectPrefix('')).toBe(false);
    expect(isProjectPrefix(' ')).toBe(false);
    expect(isProjectPrefix('a b')).toBe(false);
    expect(isProjectPrefix('prefix-')).toBe(false);
    expect(isProjectPrefix(' own-news')).toBe(false);
  });
});
