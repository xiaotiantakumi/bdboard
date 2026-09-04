import { describe, expect, it } from 'vitest';
import { isImeComposingKeyEvent } from './imeGuard';

describe('isImeComposingKeyEvent', () => {
  it('returns true when isComposing is true', () => {
    expect(isImeComposingKeyEvent({ isComposing: true })).toBe(true);
  });

  it('returns true when nativeEvent.isComposing is true', () => {
    expect(
      isImeComposingKeyEvent({ nativeEvent: { isComposing: true } }),
    ).toBe(true);
  });

  it('returns true when keyCode is 229 (legacy IME fallback)', () => {
    expect(isImeComposingKeyEvent({ keyCode: 229 })).toBe(true);
  });

  it('returns false for a normal Enter keydown', () => {
    expect(isImeComposingKeyEvent({ isComposing: false, keyCode: 13 })).toBe(
      false,
    );
  });

  it('returns false for an empty event object', () => {
    expect(isImeComposingKeyEvent({})).toBe(false);
  });
});
