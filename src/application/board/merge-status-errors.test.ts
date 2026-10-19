import { describe, expect, it } from 'vitest';
import { mergeStatusErrors } from './merge-status-errors.js';

const e = (projectId: string, detail = 'x') => ({ kind: 'unknown', projectId, detail });

describe('mergeStatusErrors', () => {
  it('replaces everything on a full refresh', () => {
    expect(mergeStatusErrors([e('a'), e('b')], [e('c')], [], undefined)).toEqual([e('c')]);
  });

  it('keeps errors of projects outside a partial refresh and replaces refreshed ones', () => {
    const merged = mergeStatusErrors(
      [e('a', 'old'), e('b', 'old')],
      [e('a', 'new')],
      [],
      ['a'],
    );
    expect(merged).toEqual([e('b', 'old'), e('a', 'new')]);
  });

  it('clears the error of a refreshed project that now succeeds, keeping the others', () => {
    expect(mergeStatusErrors([e('a'), e('b')], [], [], ['a'])).toEqual([e('b')]);
  });

  it('drops errors of removed projects', () => {
    expect(mergeStatusErrors([e('a'), e('b'), e('c')], [], ['b'], ['a'])).toEqual([e('c')]);
  });
});
