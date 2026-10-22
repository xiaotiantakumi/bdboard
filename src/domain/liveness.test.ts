import { describe, expect, it } from 'vitest';
import { DEFAULT_LIVENESS_THRESHOLDS } from './liveness.js';

describe('DEFAULT_LIVENESS_THRESHOLDS', () => {
  // Regression guard for bdboard-3tw.37: this is a product decision, not a
  // structural invariant, so nothing else here would catch it reverting.
  it('sets the active threshold to 5 minutes', () => {
    expect(DEFAULT_LIVENESS_THRESHOLDS.activeMs).toBe(5 * 60_000);
  });
});
