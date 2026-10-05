import { describe, expect, it } from 'vitest';
import { buildPublicIssueBody } from './issue-public-build.js';
import type { LocalOnlyKeys, PublicBuildInput } from './issue-public-types.js';

const BASE: PublicBuildInput = {
  kind: 'C',
  source: 'probe-hook',
  versions: { bdboardVersion: '1.2.3', os: 'Test OS', nodeVersion: 'v22' },
  occurrenceCount: 1,
  firstOccurredAt: '2026-10-04T00:00:00Z',
  lastOccurredAt: '2026-10-04T00:00:00Z',
};
const FRAGMENT = '<redacted-fragment>';

describe('variants merged for the search still give every spelling to the edge check (bdboard-uudb)', () => {
  // 単純なたたみでは同じだが toLowerCase では違う文字 (µ/μ・ς/σ・ϑ/θ・ſ/s・U+1FBE/ι)。
  it.each([
    ['two names, micro sign and mu', ['µexample-project', 'μexample-project'], 'failed in μexample-pro', 'μexample-pro'],
    ['two names, final and medial sigma', ['example-projς-x', 'example-projσ-x'], 'failed in example-projσ', 'example-projσ'],
    ['one name whose NFC variant differs (U+1FBE -> iota)', ['ιexample-user'], 'owner ιexample-us', 'ιexample-us'],
  ] as const)('%s', (_name, values, text, piece) => {
    const keys: LocalOnlyKeys = { projectRoots: [], properNouns: values.map((value) => ({ category: 'project' as const, value })) };
    const result = buildPublicIssueBody({ ...BASE, symptom: text }, keys);
    expect(result.body).not.toContain(piece);
    expect(result.body).toContain(FRAGMENT);
  });
});
