import { describe, expect, it } from 'vitest';
import { prepareKeys } from './issue-public-keys.js';
import { detectSuspectedLeaks } from './issue-public-leaks.js';
import type { LocalOnlyKeys, ProperNounCategory, RedactionMark } from './issue-public-types.js';

const mark = (field: 'title' | 'body', start: number, end: number): RedactionMark => ({ field, kind: 'token', start, end });

describe('detectSuspectedLeaks: every class of leak is reported on raw (bypassed) text', () => {
  const token = 'ghp_' + 'x'.repeat(36);
  const begin = '-----' + 'BEGIN PRIVATE KEY' + '-----';

  it.each<[ProperNounCategory]>([['project'], ['user'], ['host'], ['branch']])(
    'flags a long %s noun (case-insensitively) with its category',
    (category) => {
      const prepared = prepareKeys({ projectRoots: [], properNouns: [{ category, value: 'example-noun' }] });
      expect(detectSuspectedLeaks('body', 'see Example-Noun here', [], prepared)).toEqual([
        { field: 'body', kind: category, start: 4, end: 16, matched: 'Example-Noun' },
      ]);
    },
  );

  it.each<[ProperNounCategory]>([['project'], ['user'], ['host'], ['branch']])(
    'flags a short %s noun only as a whole word',
    (category) => {
      const prepared = prepareKeys({ projectRoots: [], properNouns: [{ category, value: 'tom' }] });
      expect(detectSuspectedLeaks('title', 'custom tom tomato', [], prepared)).toEqual([
        { field: 'title', kind: category, start: 7, end: 10, matched: 'tom' },
      ]);
    },
  );

  it('flags project roots, home paths, tokens, key blocks and e-mail with their kinds, sorted by start', () => {
    const text = `a example-user@example.com b ${token} c /home/example-user/x d /work/example-project/src e ${begin} secret`;
    const prepared = prepareKeys({ projectRoots: ['/work/example-project'], properNouns: [] });
    const leaks = detectSuspectedLeaks('body', text, [], prepared);
    // 根のフォルダ名 (example-project) は project の固有名詞としても登録されるので、project-path の内側にもう 1 件出る。
    expect(leaks.map(({ kind }) => kind)).toEqual(['email', 'token', 'home-path', 'project-path', 'project', 'key-block']);
    for (const leak of leaks) expect(text.slice(leak.start, leak.end)).toBe(leak.matched);
    expect(leaks.map(({ start }) => start)).toEqual([...leaks.map(({ start }) => start)].sort((x, y) => x - y));
  });

  describe('the report-only patterns are looser than the redactor (so a gap in the redactor does not blind the net)', () => {
    const empty = prepareKeys({ projectRoots: [], properNouns: [] });
    const sk = 'sk-proj-' + 'x'.repeat(40);
    const bearer = 'Bearer ' + 'y'.repeat(30);

    it.each([
      ['an sk- key glued to an identifier', 'id1' + sk, sk],
      ['a Bearer credential glued to a word', 'x' + bearer, bearer],
      ['a lower-case AWS access key id', 'akia' + 'x'.repeat(16), 'akia' + 'x'.repeat(16)],
    ])('reports %s', (_name, text, expected) => {
      expect(detectSuspectedLeaks('body', text, [], empty).map((leak) => [leak.kind, leak.matched])).toEqual([['token', expected]]);
    });

    it('reports a lone key block marker (BEGIN without END, END without BEGIN)', () => {
      for (const marker of [begin, '-----' + 'END PRIVATE KEY' + '-----']) {
        const leaks = detectSuspectedLeaks('body', `log ${marker} tail`, [], empty);
        expect(leaks.map((leak) => leak.kind)).toEqual(['key-block']);
        expect(leaks[0]?.start).toBeLessThanOrEqual(4);
        expect(leaks[0]?.end).toBeGreaterThanOrEqual(4 + marker.length);
      }
    });

    it('over-reports a long hyphenated word that ends in sk- (by design: a person looks, nothing is rewritten)', () => {
      const text = 'the task-force-coordination-with-a-very-long-team-name';
      expect(detectSuspectedLeaks('body', text, [], empty).map((leak) => leak.kind)).toEqual(['token']);
    });
  });

  it('reports nothing for clean text', () => {
    const prepared = prepareKeys({ projectRoots: ['/work/example-project'], properNouns: [{ category: 'user', value: 'example-user' }] });
    expect(detectSuspectedLeaks('body', 'nothing to see here ~/x <user> <project>', [], prepared)).toEqual([]);
  });
});

describe('detectSuspectedLeaks: placeholders are not leaks', () => {
  const prepared = prepareKeys({
    projectRoots: [],
    properNouns: [
      { category: 'user', value: 'email' },
      { category: 'project', value: 'project' },
      { category: 'host', value: 'token' },
      { category: 'branch', value: 'redacted' },
    ],
  });

  it('does not flag a noun that is literally part of a placeholder', () => {
    const text = '<email> <project> <redacted-token> <redacted-key-block>';
    const marks: RedactionMark[] = [
      { field: 'body', kind: 'email', start: 0, end: 7 },
      { field: 'body', kind: 'project', start: 8, end: 17 },
      { field: 'body', kind: 'token', start: 18, end: 34 },
      { field: 'body', kind: 'key-block', start: 35, end: 55 },
    ];
    expect(detectSuspectedLeaks('body', text, marks, prepared)).toEqual([]);
  });

  it('flags the same words outside the marks', () => {
    const text = '<email> email <project>x';
    const marks: RedactionMark[] = [
      { field: 'body', kind: 'email', start: 0, end: 7 },
      { field: 'body', kind: 'project', start: 14, end: 23 },
    ];
    const leaks = detectSuspectedLeaks('body', text, marks, prepared);
    expect(leaks.map(({ matched, start }) => [matched, start])).toEqual([['email', 8]]);
  });

  it('uses only the marks of the same field', () => {
    const text = '<email>';
    const marks: RedactionMark[] = [{ field: 'title', kind: 'email', start: 0, end: 7 }];
    expect(detectSuspectedLeaks('title', text, marks, prepared)).toEqual([]);
    expect(detectSuspectedLeaks('body', text, marks, prepared)).toHaveLength(1);
  });

  it('flags a candidate that starts inside a mark but ends outside it, or that only touches it', () => {
    const prepared2 = prepareKeys({ projectRoots: [], properNouns: [{ category: 'user', value: 'abcdef' }] });
    expect(detectSuspectedLeaks('body', 'abcdef', [mark('body', 0, 5)], prepared2)).toHaveLength(1);
    expect(detectSuspectedLeaks('body', 'abcdef', [mark('body', 1, 6)], prepared2)).toHaveLength(1);
    expect(detectSuspectedLeaks('body', 'abcdef', [mark('body', 0, 6)], prepared2)).toEqual([]);
    expect(detectSuspectedLeaks('body', 'abcdef', [mark('body', 0, 3), mark('body', 3, 6)], prepared2)).toHaveLength(1);
  });

  it('covers a candidate with a wide mark even when smaller marks are listed around it (unsorted, overlapping)', () => {
    const prepared2 = prepareKeys({ projectRoots: [], properNouns: [{ category: 'user', value: 'abcdef' }] });
    const marks = [mark('body', 4, 5), mark('body', 0, 6), mark('body', 2, 3), mark('body', 10, 20)];
    expect(detectSuspectedLeaks('body', 'abcdef', marks, prepared2)).toEqual([]);
  });
});

describe('detectSuspectedLeaks: scale', () => {
  it('stays fast with tens of thousands of marks and candidates', () => {
    const keys: LocalOnlyKeys = { projectRoots: [], properNouns: [{ category: 'user', value: 'ab' }] };
    const prepared = prepareKeys(keys);
    const marks: RedactionMark[] = [];
    let text = '';
    for (let index = 0; index < 20_000; index += 1) {
      marks.push(mark('body', text.length, text.length + 7));
      text += '<email> ab ';
    }
    const started = performance.now();
    const leaks = detectSuspectedLeaks('body', text, marks, prepared);
    expect(performance.now() - started).toBeLessThan(2000);
    expect(leaks).toHaveLength(20_000);
  });
});
