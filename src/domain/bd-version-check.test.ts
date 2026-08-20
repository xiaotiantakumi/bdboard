import { describe, expect, it } from 'vitest';
import { EXPECTED_BD_VERSION, evaluateBdVersion } from './bd-version-check.js';

describe('evaluateBdVersion', () => {
  it('returns match when the installed version is the expected version', () => {
    expect(evaluateBdVersion(EXPECTED_BD_VERSION)).toEqual({
      status: 'match',
      message: `bd CLI version matches expected ${EXPECTED_BD_VERSION}.`,
    });
  });

  it('returns a prominent mismatch message when the installed version differs', () => {
    expect(evaluateBdVersion('1.2.2')).toEqual({
      status: 'mismatch',
      message: `bd CLI version mismatch: expected ${EXPECTED_BD_VERSION}, found 1.2.2. See README for why ${EXPECTED_BD_VERSION} is pinned (bd-m7zzd regression).`,
    });
  });

  it('returns unknown when the installed version could not be read', () => {
    expect(evaluateBdVersion(null)).toEqual({
      status: 'unknown',
      message: `bd CLI version could not be determined; expected ${EXPECTED_BD_VERSION}.`,
    });
  });
});
