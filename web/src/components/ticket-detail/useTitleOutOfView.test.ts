import { describe, expect, it } from 'vitest';
import { mobileBarLabel } from './useTitleOutOfView';

describe('mobileBarLabel', () => {
  it('shows the ticket id while the title is in view', () => {
    expect(mobileBarLabel(false, 'bdboard-1', 'Title')).toBe('bdboard-1');
  });
  it('shows the title once it scrolled out of view', () => {
    expect(mobileBarLabel(true, 'bdboard-1', 'Title')).toBe('Title');
  });
  it('falls back to the id when the title is missing or blank', () => {
    expect(mobileBarLabel(true, 'bdboard-1', undefined)).toBe('bdboard-1');
    expect(mobileBarLabel(true, 'bdboard-1', '  ')).toBe('bdboard-1');
  });
});
