import { describe, expect, it } from 'vitest';
import { hasCloseEvidenceMarker } from './close-evidence-marker.js';

describe('hasCloseEvidenceMarker', () => {
  it('returns true when text contains half-width PR:', () => {
    expect(hasCloseEvidenceMarker('merged via PR: https://github.com/x/y/pull/1')).toBe(true);
  });

  it('returns true when text contains full-width PR：', () => {
    expect(hasCloseEvidenceMarker('PR：https://github.com/x/y/pull/2')).toBe(true);
  });

  it('returns true when text contains half-width 検証:', () => {
    expect(hasCloseEvidenceMarker('手元で検証: npm run verify 通過')).toBe(true);
  });

  it('returns true when text contains full-width 検証：', () => {
    expect(hasCloseEvidenceMarker('検証：TZ=UTC npm run verify 通過')).toBe(true);
  });

  it('returns false when text contains neither marker', () => {
    expect(hasCloseEvidenceMarker('close しました')).toBe(false);
  });
});
