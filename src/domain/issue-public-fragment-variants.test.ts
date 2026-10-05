import { describe, expect, it } from 'vitest';
import { buildPublicIssueBody } from './issue-public-build.js';
import { findEdgeFragmentSpans, toFragmentKey } from './issue-public-fragments.js';
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

describe('the edge check folds case the way the body search does (bdboard-2ydj)', () => {
  // 鍵は 1 つだけ (固有名詞 1 件) にし、鍵と断片で同じ類の別の文字を使う: 複数の綴りを並べると、変種として足されて toLowerCase でも通る。
  // 文字は鍵の真ん中に置く: 末尾の前置部分 (`exaXple-pro`) にも、先頭の後置部分 (`Xple-project`) にも入る。
  const CLASSES = [
    ['micro sign and mu', 'µ', 'μ'],
    ['final sigma and sigma', 'ς', 'σ'],
    ['theta symbol and theta', 'ϑ', 'θ'],
    ['long s and s', 'ſ', 's'],
    // U+1FBE の NFC は ι (U+03B9): 鍵が U+1FBE なら NFC の変種が ι の断片を拾うので、落ちるのは鍵が ι、断片が U+1FBE の向き。
    ['U+1FBE and iota', 'ι', 'ι'],
  ] as const;
  const DIRECTIONS = CLASSES.flatMap(([name, left, right]) => [
    [`${name}: key has the first, text has the second`, left, right],
    [`${name}: key has the second, text has the first`, right, left],
  ] as const);
  const keysFor = (keyCharacter: string): LocalOnlyKeys => ({
    projectRoots: [],
    properNouns: [{ category: 'project', value: `exa${keyCharacter}ple-project` }],
  });

  it.each(DIRECTIONS)('replaces a cut at the end of a field: %s', (_name, keyCharacter, textCharacter) => {
    const piece = `exa${textCharacter}ple-pro`;
    const result = buildPublicIssueBody({ ...BASE, symptom: `first line\nowner ${piece}` }, keysFor(keyCharacter));
    expect(result.body).not.toContain(piece);
    expect(result.body).toContain(`owner ${FRAGMENT}`);
  });

  it.each(DIRECTIONS)('replaces a cut at the start of the error text: %s', (_name, keyCharacter, textCharacter) => {
    const piece = `${textCharacter}ple-project`;
    const result = buildPublicIssueBody({ ...BASE, errorText: `${piece}\nremaining text` }, keysFor(keyCharacter));
    expect(result.body).not.toContain(piece);
    expect(result.body).toContain(`${FRAGMENT}\nremaining text`);
  });

  it.each(DIRECTIONS)('finds the fragment at both edges of the folded key: %s', (_name, keyCharacter, textCharacter) => {
    const key = toFragmentKey(`exa${keyCharacter}ple-project`);
    const tail = `owner exa${textCharacter}ple-pro`;
    expect(findEdgeFragmentSpans(tail, [key], { start: false, end: true })).toEqual([{ kind: 'fragment', start: 6, end: tail.length }]);
    const head = `${textCharacter}ple-project and more`;
    expect(findEdgeFragmentSpans(head, [key], { start: true, end: false })).toEqual([
      { kind: 'fragment', start: 0, end: `${textCharacter}ple-project`.length },
    ]);
  });
});
