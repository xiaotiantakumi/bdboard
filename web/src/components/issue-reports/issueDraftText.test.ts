import { describe, expect, it } from 'vitest';
import {
  compareHarnessVersions,
  describeLeaks,
  draftKindLabel,
  leakKindLabel,
  omittedLeakCount,
  segmentMarkedText,
} from './issueDraftText';

describe('issueDraftText (bdboard-4y8q.3.2)', () => {
  it('labels known leak kinds and falls back to a generic label for an unknown kind', () => {
    expect(leakKindLabel('home-path')).toBe('ホームのパス');
    expect(leakKindLabel('key-overflow')).toBe('探しきれていない名前');
    expect(leakKindLabel('brand-new-kind')).toBe('その他の疑い (brand-new-kind)');
    expect(leakKindLabel('x'.repeat(100))).toBe(`その他の疑い (${'x'.repeat(40)}…)`);
    expect(draftKindLabel('Z')).toBe('種類 Z');
  });

  it('cuts the excerpt from the saved text and drops positions that are out of range or missing', () => {
    const saved = { title: 'Fails in example-project', body: 'path /Users/example-user/x' };
    const items = describeLeaks(saved, [
      { field: 'title', kind: 'project', start: 9, end: 24 },
      { field: 'body', kind: 'mystery', start: 5, end: 26 },
      { field: 'body', kind: 'token', start: 10, end: 999 },
      { field: 'body', kind: 'key-overflow', start: 0, end: 0 },
    ]);
    expect(items.map((item) => [item.fieldLabel, item.label, item.excerpt])).toEqual([
      ['題名', 'プロジェクト名', 'example-project'],
      ['本文', 'その他の疑い (mystery)', '/Users/example-user/x'],
      ['本文', 'トークンらしい文字列', undefined],
      ['本文', '探しきれていない名前', undefined],
    ]);
    expect(describeLeaks(saved, undefined)).toEqual([]);
  });

  it('reads the omitted count from a number, a flag, or nothing', () => {
    expect(omittedLeakCount(3)).toBe(3);
    expect(omittedLeakCount(0)).toBe(0);
    expect(omittedLeakCount(true)).toBe('some');
    expect(omittedLeakCount(undefined)).toBe(0);
    expect(omittedLeakCount('7')).toBe(0);
  });

  it('marks redaction placeholders and suspected leaks, with leaks taking priority', () => {
    const text = 'at <project>/src by alice';
    expect(segmentMarkedText(text, [{ start: 20, end: 25 }])).toEqual([
      { text: 'at ', mark: 'none' },
      { text: '<project>', mark: 'redaction' },
      { text: '/src by ', mark: 'none' },
      { text: 'alice', mark: 'leak' },
    ]);
    expect(segmentMarkedText('', [{ start: 0, end: 1 }])).toEqual([]);
    expect(segmentMarkedText('abc', [{ start: 2, end: 9 }])).toEqual([{ text: 'abc', mark: 'none' }]);
  });

  it('labels the fragment kind and marks every redaction placeholder, including <redacted-fragment> and <redacted-token>', () => {
    expect(leakKindLabel('fragment')).toBe('途中で切れた名前の断片');
    for (const placeholder of ['<redacted-fragment>', '<redacted-token>', '<redacted-key-block>', '<user>', '<host>', '<branch>', '<email>']) {
      expect(segmentMarkedText(`x ${placeholder} y`, [])).toEqual([
        { text: 'x ', mark: 'none' },
        { text: placeholder, mark: 'redaction' },
        { text: ' y', mark: 'none' },
      ]);
    }
  });

  it('compares harness versions and copes with missing values', () => {
    expect(compareHarnessVersions('1.2.0', '1.3.0')).toEqual({ kind: 'different', occurred: '1.2.0', latest: '1.3.0' });
    expect(compareHarnessVersions('1.3.0', '1.3.0').kind).toBe('same');
    expect(compareHarnessVersions(undefined, '1.3.0')).toEqual({ kind: 'unknown-occurrence', latest: '1.3.0' });
    expect(compareHarnessVersions('  ', null)).toEqual({ kind: 'unknown-occurrence', latest: undefined });
    expect(compareHarnessVersions('1.2.0', null)).toEqual({ kind: 'unknown-latest', occurred: '1.2.0' });
  });
});
