import { describe, expect, it } from 'vitest';
import { buildPublicIssueBody } from './issue-public-build.js';
import { caseInsensitiveLiteral, escapeRegExp, fallbackLiteral } from './issue-public-casefold.js';
import { prepareKeys } from './issue-public-keys.js';
import { literalSearcher } from './issue-public-literal-search.js';
import { redactText } from './issue-public-redact.js';
import type { LocalOnlyKeys, PublicBuildInput } from './issue-public-types.js';
import { LINEAR_TIME_TEST_TIMEOUT_MS, expectLinearTime } from './linear-time-test-support.js';

// bdboard-0hj9: 鍵が自分と重なる (周期的な綴り) とき、欄の途中で重なって 2 回現れる出現の 2 回目の後ろが残っていた。

const BASE: PublicBuildInput = {
  kind: 'C',
  source: 'probe-hook',
  versions: { bdboardVersion: '1.2.3', os: 'Test OS', nodeVersion: 'v22' },
  occurrenceCount: 1,
  firstOccurredAt: '2026-10-04T00:00:00Z',
  lastOccurredAt: '2026-10-04T00:00:00Z',
};

const nounKeys = (value: string): LocalOnlyKeys => ({ projectRoots: [], properNouns: [{ category: 'project', value }] });

/** 正規表現エンジンで出す独立の正解: 先読みの捕獲 `(?=(鍵)(?!直後の文字))` で重なる出現もすべて集め、厳密に重なるものを併合する (接するだけは別)。 */
function oracle(text: string, key: string, root: boolean): { start: number; end: number }[] {
  const pattern = new RegExp(`(?=(${escapeRegExp(key)}${root ? '(?![\\p{L}\\p{N}_-])' : ''}))`, 'giu');
  const spans: { start: number; end: number }[] = [];
  for (const match of text.matchAll(pattern)) {
    const start = match.index;
    const end = start + (match[1]?.length ?? 0);
    const previous = spans.at(-1);
    if (previous !== undefined && start < previous.end) previous.end = Math.max(previous.end, end);
    else spans.push({ start, end });
  }
  return spans;
}

/** シード固定の乱数 (既存のテストと同じ LCG)。 */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state >>> 8;
  };
}

const CLASSES = [
  ['s', 'ſ', 'S'],
  ['σ', 'ς', 'Σ'],
  ['θ', 'ϑ', 'Θ'],
] as const;

describe('a name that overlaps itself and appears twice in one field', () => {
  it.each([
    ['name with a leading dash', '-ba1-ba1-ba', 'log: -ba1-ba1-ba1-ba done', 'log: <project> done'],
    ['name without the dash', 'ba1-ba1-ba', 'log: -ba1-ba1-ba1-ba done', 'log: -<project> done'],
    ['final sigma and sigma', '-baς-baσ-ba', 'log: -baς-baς-baς-ba done', 'log: <project> done'],
  ])('redacts the whole run in a multi-line field: %s', (_label, name, text, expected) => {
    for (const field of ['symptom', 'errorText', 'agentNote'] as const) {
      const result = buildPublicIssueBody({ ...BASE, [field]: `first line\n${text}` }, nounKeys(name));
      expect(result.body, field).toContain(`\n${expected}\n`);
      expect(result.body, field).not.toContain('1-ba');
      expect(result.body, field).not.toContain('ς-ba');
    }
  });

  it('redacts the whole run in the one-line fields, which have no edge check', () => {
    const run = 'hook -ba1-ba1-ba1-ba';
    const result = buildPublicIssueBody(
      { ...BASE, source: run, versions: { ...BASE.versions, os: run }, firstOccurredAt: run },
      nounKeys('-ba1-ba1-ba'),
    );
    expect(result.title).toContain('`hook <project>`');
    expect(result.body).toContain('- 対象: `hook <project>`');
    expect(result.body).toContain('- OS: `hook <project>`');
    expect(result.body).toContain('- 最初に起きた時刻: `hook <project>`');
    expect(result.body).not.toContain('1-ba');
    expect(result.suspectedLeaks).toHaveLength(0);
  });
});

describe('literalSearcher: every occurrence is found and overlapping ones are merged', () => {
  const search = (text: string, key: string, root: boolean) => literalSearcher(text)(caseInsensitiveLiteral(key, root));

  it('merges strictly overlapping occurrences and keeps touching ones apart', () => {
    expect(search('aaaa', 'aa', false)).toEqual([{ start: 0, end: 4 }]);
    expect(search('xabababx', 'abab', false)).toEqual([{ start: 1, end: 7 }]);
    expect(search('abababab', 'abab', false)).toEqual([{ start: 0, end: 8 }]);
    expect(search('abcdabcd', 'abcd', false)).toEqual([
      { start: 0, end: 4 },
      { start: 4, end: 8 },
    ]);
  });

  it('looks at the follower of every root occurrence and keeps reading after a rejected one', () => {
    // '/a/a/a' は 0・2・4 で始まる 3 つの出現が重なる。
    expect(search('/a/a/a/a/a here', '/a/a/a', true)).toEqual([{ start: 0, end: 10 }]);
    // 0 の出現 (直後の a) は外れるが、重なる 2 の出現は通る。
    expect(search('ababab.', 'abab', true)).toEqual([{ start: 2, end: 6 }]);
    // '/ab/ab' は 0 と 3 の出現が通り、6 の出現は直後が c で外れる。
    expect(search('/ab/ab/ab/abc', '/ab/ab', true)).toEqual([{ start: 0, end: 9 }]);
  });

  it('closes the leak for a periodic root in a field', () => {
    const keys: LocalOnlyKeys = { projectRoots: ['/srv/srv/srv'], properNouns: [] };
    const result = buildPublicIssueBody({ ...BASE, symptom: 'see /srv/srv/srv/srv/srv here' }, keys);
    expect(result.body).toContain('see <project> here');
  });

  it('matches an independent regex oracle on seeded periodic keys, with and without the root rule', () => {
    const next = lcg(0x4f1bbcdd);
    for (let run = 0; run < 2_000; run += 1) {
      const classes = CLASSES[next() % CLASSES.length] ?? CLASSES[0];
      const pool = ['a', 'b', '-', '1', classes[0]];
      const unit = Array.from({ length: 1 + (next() % 4) }, () => pool[next() % pool.length] ?? 'a').join('');
      const keyLength = 5 + (next() % 8);
      const key = Array.from({ length: keyLength }, (_, index) => {
        const character = unit.charAt(index % unit.length);
        return (classes as readonly string[]).includes(character) && next() % 3 === 0 ? (classes[next() % classes.length] ?? character) : character;
      }).join('');
      const pieces = [key, key.slice(0, 1 + (next() % key.length)), key.slice(-1 - (next() % key.length)), unit, ' ', '2', 'x', '.', '/'];
      const text = Array.from({ length: 1 + (next() % 6) }, () => pieces[next() % pieces.length] ?? '').join('');
      const root = next() % 2 === 0;
      expect({ key, text, root, spans: search(text, key, root) }).toEqual({ key, text, root, spans: oracle(text, key, root) });
    }
  });

  it('the regex fallback for engines without the case table returns the same ranges as the table', () => {
    // V8 では表が使えるので、退避の正規表現 (先読みの捕獲) はこのテストからしか走らない。
    const next = lcg(0x2f0d);
    for (let run = 0; run < 2_000; run += 1) {
      const classes = CLASSES[next() % CLASSES.length] ?? CLASSES[0];
      const pool = ['a', 'b', '-', '1', classes[0], classes[1]];
      const unit = Array.from({ length: 1 + (next() % 4) }, () => pool[next() % pool.length] ?? 'a').join('');
      const key = unit.repeat(Math.ceil((4 + (next() % 9)) / unit.length));
      const pieces = [key, key.slice(0, 1 + (next() % key.length)), key.slice(-1 - (next() % key.length)), unit, classes[2], ' ', '2', '.'];
      const text = Array.from({ length: 1 + (next() % 6) }, () => pieces[next() % pieces.length] ?? '').join('');
      const root = next() % 2 === 0;
      const table = literalSearcher(text)(caseInsensitiveLiteral(key, root));
      expect({ key, text, root, spans: literalSearcher(text)(fallbackLiteral(key, root)) }).toEqual({ key, text, root, spans: table });
      expect(table).toEqual(oracle(text, key, root));
    }
  });

  it('replaces every merged run of a periodic name after redactText, tails included', () => {
    const next = lcg(0x8a21);
    const alphabet = ['a', 'b', '-', '1', 's', 'ſ', 'S', 'σ', 'ς', 'Σ', 'θ', 'ϑ', 'Θ'];
    for (let run = 0; run < 1_000; run += 1) {
      const unit = Array.from({ length: 1 + (next() % 4) }, () => alphabet[next() % alphabet.length] ?? 'a').join('');
      const length = 5 + (next() % 8);
      const key = unit.repeat(Math.ceil(length / unit.length)).slice(0, length);
      const text = Array.from({ length: 1 + (next() % 6) }, () => [key, unit, ' ', '2', 'x', '.', '/'][next() % 7] ?? '').join('');
      const output = redactText(text, prepareKeys(nounKeys(key))).text;
      // 正解の範囲 (重なる出現を併合したもの) をそれぞれ印 1 つに替えた文字列と一致する。完全な鍵が残らないことだけを見ると、
      // 重なった 2 つ目の出現の後ろ (以前の `<project>1-ba`) は鍵の出現ではないので、以前の実装でも通ってしまう。
      let expected = '';
      let from = 0;
      for (const span of oracle(text, key, false)) {
        expected += `${text.slice(from, span.start)}<project>`;
        from = span.end;
      }
      expected += text.slice(from);
      expect({ key, text, output }).toEqual({ key, text, output: expected });
    }
  });
});

describe('linear time with keys that overlap themselves', () => {
  // [名前, 鍵の単位, 鍵の繰り返し, 本文の単位, 本文の繰り返し, 根か, 本文の末尾]
  // 鍵の繰り返しも本文と同じ縮尺で伸ばす: 鍵の長さを固定すると、出現ごとに 1 つ右から探し直す O(本文 × 鍵) の実装
  // (bdboard-0hj9 より前の根の探し方や、素朴な全出現の列挙) も本文の長さには線形で、比に現れない。
  const SHAPES = [
    ['one repeated character', 'a', 1_000, 'a', 100_000, false, ''],
    ['two-character period', 'ab', 500, 'ab', 50_000, false, ''],
    ['root with a period, mixed followers', '/a', 500, '/a', 50_000, true, 'b'],
    ['root whose every occurrence is rejected by the follower', 'a', 1_000, 'a', 100_000, true, ''],
    ['dense occurrences of a plain key', 'abcd', 1, 'abcd', 25_000, false, ''],
  ] as const;

  it.each(SHAPES)('literalSearcher grows linearly: %s', (label, unit, copies, textUnit, textCopies, root, tail) => {
    expectLinearTime(
      `literalSearcher: ${label}`,
      (n) => {
        const key = caseInsensitiveLiteral(unit.repeat(n(copies)), root);
        const text = textUnit.repeat(n(textCopies)) + tail;
        return () => {
          literalSearcher(text)(key);
        };
      },
      {},
    );
  }, LINEAR_TIME_TEST_TIMEOUT_MS);

  it('buildPublicIssueBody grows linearly with a periodic name in the error text', () => {
    expectLinearTime('buildPublicIssueBody: periodic name', (n) => {
      const keys = nounKeys('ab'.repeat(n(250)));
      const errorText = 'ab'.repeat(n(50_000));
      return () => {
        buildPublicIssueBody({ ...BASE, errorText }, keys);
      };
    });
  }, LINEAR_TIME_TEST_TIMEOUT_MS);
});
