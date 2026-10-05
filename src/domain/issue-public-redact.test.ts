import { describe, expect, it } from 'vitest';
import { prepareKeys } from './issue-public-keys.js';
import { elide, redactText, type RedactedText } from './issue-public-redact.js';
import type { RedactionKind } from './issue-public-types.js';

const EMPTY = prepareKeys({ projectRoots: [], properNouns: [] });
const PLACEHOLDERS: Readonly<Record<RedactionKind, string>> = {
  'project-path': '<project>',
  'home-path': '~/',
  project: '<project>',
  user: '<user>',
  host: '<host>',
  branch: '<branch>',
  'key-block': '<redacted-key-block>',
  token: '<redacted-token>',
  email: '<email>',
  fragment: '<redacted-fragment>',
};
const BEGIN = '-----' + 'BEGIN PRIVATE KEY' + '-----';
const END = '-----' + 'END PRIVATE KEY' + '-----';

/** 印の不変条件: 位置の順・重なりなし・各印の切り出しが種別の印の文字列と一致する。 */
function expectExactMarks(result: RedactedText): void {
  let previousEnd = 0;
  for (const mark of result.marks) {
    expect(mark.start).toBeGreaterThanOrEqual(previousEnd);
    expect(mark.end).toBeGreaterThan(mark.start);
    expect(result.text.slice(mark.start, mark.end)).toBe(PLACEHOLDERS[mark.kind]);
    previousEnd = mark.end;
  }
}

const KEYS = prepareKeys({
  projectRoots: ['/work/example-project', '/Users/example-user/work/example-project', 'C:\\work\\example-project'],
  properNouns: [
    { category: 'project', value: 'example-project' },
    { category: 'user', value: 'example-user' },
    { category: 'host', value: 'example-host' },
    { category: 'branch', value: 'feature-example' },
  ],
});

describe('redactText: token shapes', () => {
  it.each([
    ['github', () => 'ghp_' + 'x'.repeat(36)],
    ['github fine-grained', () => 'github_pat_' + 'x'.repeat(30)],
    ['OpenAI legacy', () => 'sk-' + 'x'.repeat(40)],
    ['OpenAI project', () => 'sk-proj-' + 'ab_-'.repeat(12)],
    ['Anthropic', () => 'sk-ant-' + 'x'.repeat(40)],
    ['AWS', () => 'AKIA' + 'X'.repeat(16)],
    ['AWS STS', () => 'ASIA' + 'X'.repeat(16)],
    ['Slack', () => 'xoxb-' + '0'.repeat(20)],
    ['Google', () => 'AIza' + 'x'.repeat(35)],
    ['npm', () => 'npm_' + 'x'.repeat(36)],
    ['Bearer', () => 'Bearer ' + 'x'.repeat(24)],
  ])('removes the complete %s token and marks exactly its placeholder', (_name, make) => {
    const token = make();
    expect(redactText(token, EMPTY)).toEqual({ text: '<redacted-token>', marks: [{ kind: 'token', start: 0, end: 16 }] });
    const result = redactText(`pre ${token} post`, EMPTY);
    expect(result.text).toBe('pre <redacted-token> post');
    expect(result.marks).toEqual([{ kind: 'token', start: 4, end: 20 }]);
  });
});

describe('redactText: other classes and positions', () => {
  it('replaces e-mail, key blocks (terminated and unterminated), home paths and project paths', () => {
    expect(redactText('mail example-user@example.com now', EMPTY).text).toBe('mail <email> now');
    expect(redactText(`a ${BEGIN}\n${'x'.repeat(64)}\n${END} b`, EMPTY).text).toBe('a <redacted-key-block> b');
    expect(redactText(`a ${BEGIN}\nsecret to the end`, EMPTY)).toEqual({
      text: 'a <redacted-key-block>',
      marks: [{ kind: 'key-block', start: 2, end: 22 }],
    });
    expect(redactText('/home/example-user/x C:\\Users\\example-user\\y /mnt/c/Users/example-user/z', EMPTY).text).toBe('~/x ~/y ~/z');
    expect(redactText('/work/example-project/src/a.ts and C:\\work\\example-project\\src', KEYS).text).toBe(
      '<project>/src/a.ts and <project>\\src',
    );
  });

  it('writes output marks that are exact, sorted and non-overlapping for a mixed text', () => {
    const token = 'ghp_' + 'x'.repeat(36);
    const text = `/work/example-project/src /Users/example-user/x Example-Host ${token} example-user@example.com feature-example`;
    const result = redactText(text, KEYS);
    expect(result.text).toBe('<project>/src ~/x <host> <redacted-token> <user> <branch>');
    expect(result.marks.map((mark) => mark.kind)).toEqual(['project-path', 'home-path', 'host', 'token', 'user', 'branch']);
    expectExactMarks(result);
  });

  it('leaves text without anything to redact unchanged, with no marks', () => {
    expect(redactText('plain text 😀 /usr/bin/node', KEYS)).toEqual({ text: 'plain text 😀 /usr/bin/node', marks: [] });
  });

  it('keeps touching-but-not-overlapping matches separate', () => {
    const result = redactText('AKIA' + 'X'.repeat(16) + 'xoxb-' + '0'.repeat(20), EMPTY);
    expect(result.text).toBe('<redacted-token><redacted-token>');
    expect(result.marks).toHaveLength(2);
    expectExactMarks(result);
  });
});

describe('redactText: overlapping spans are merged into their union', () => {
  it('turns a noun inside a token into one span labelled as the secret (the reviewer must see a token was there)', () => {
    const result = redactText('ghp_' + 'x'.repeat(20) + 'example-user' + 'y'.repeat(5), KEYS);
    expect(result).toEqual({ text: '<redacted-token>yyyyy', marks: [{ kind: 'token', start: 0, end: 16 }] });
  });

  it.each([
    ['a token that contains a home path', 'Bearer /Users/jdoe/' + 'x'.repeat(20), '<redacted-token>', 'token'],
    ['a token that contains a project root', 'Bearer /work/example-project/' + 'x'.repeat(20), '<redacted-token>', 'token'],
    ['a key block that contains a home path', `${BEGIN}\n/Users/jdoe/x\n${END}`, '<redacted-key-block>', 'key-block'],
    ['a key block that contains a noun', `${BEGIN}\nexample-user\n${END}`, '<redacted-key-block>', 'key-block'],
    ['a key block that contains a token', `${BEGIN}\nghp_${'x'.repeat(36)}\n${END}`, '<redacted-key-block>', 'key-block'],
  ])('labels %s as the secret, not as the path or noun inside it', (_name, text, expected, kind) => {
    const result = redactText(text, KEYS);
    expect(result.text).toBe(expected);
    expect(result.marks.map((mark) => mark.kind)).toEqual([kind]);
    expectExactMarks(result);
  });

  it('keeps the secret label when the noun starts inside the token and ends after it', () => {
    const result = redactText('ghp_' + 'x'.repeat(36) + 'example-user' + 'yyy', KEYS);
    expect(result).toEqual({ text: '<redacted-token>yyy', marks: [{ kind: 'token', start: 0, end: 16 }] });
  });

  it('turns a noun inside a home path into one home-path span', () => {
    expect(redactText('/Users/example-user/proj', KEYS)).toEqual({
      text: '~/proj',
      marks: [{ kind: 'home-path', start: 0, end: 2 }],
    });
  });

  it('prefers project-path over home-path when a root lies under the home directory', () => {
    const result = redactText('/Users/example-user/work/example-project/src/x.ts', KEYS);
    expect(result).toEqual({ text: '<project>/src/x.ts', marks: [{ kind: 'project-path', start: 0, end: 9 }] });
  });

  it('uses the highest priority kind: key-block > token > project-path > home-path > project > user > host > branch > email', () => {
    const prepared = prepareKeys({
      projectRoots: [],
      properNouns: [
        { category: 'project', value: 'alpha-beta' },
        { category: 'user', value: 'beta-gamma' },
        { category: 'host', value: 'one-two' },
        { category: 'branch', value: 'two-three' },
        { category: 'user', value: 'uuuu-vvvv' },
        { category: 'branch', value: 'vvvv-wwww' },
      ],
    });
    expect(redactText('alpha-beta-gamma', prepared).marks[0]?.kind).toBe('project');
    expect(redactText('one-two-three', prepared).marks[0]?.kind).toBe('host');
    expect(redactText('uuuu-vvvv-wwww', prepared).marks[0]?.kind).toBe('user');
    const keyBlock = redactText(`${BEGIN}\nghp_${'x'.repeat(36)}\n${END}`, EMPTY);
    expect(keyBlock).toEqual({ text: '<redacted-key-block>', marks: [{ kind: 'key-block', start: 0, end: 20 }] });
    const tokenInEmail = redactText('AKIA' + 'X'.repeat(16) + '@example.com', EMPTY);
    expect(tokenInEmail).toEqual({ text: '<redacted-token>', marks: [{ kind: 'token', start: 0, end: 16 }] });
  });

  it('does not match inside an earlier placeholder: all finders see the same input', () => {
    const prepared = prepareKeys({ projectRoots: [], properNouns: [{ category: 'host', value: 'redacted' }] });
    const result = redactText('ghp_' + 'x'.repeat(36), prepared);
    expect(result.text).toBe('<redacted-token>');
  });
});

describe('redactText: second pass (a match that only appears once a neighbour became a placeholder)', () => {
  const SK = 'sk-proj-' + 'x'.repeat(40);
  const BEARER = 'Bearer ' + 'y'.repeat(30);

  it.each([
    ['an sk- key', 'example-project' + SK, '<project><redacted-token>', ['project', 'token']],
    ['a Bearer credential', 'example-project' + BEARER, '<project><redacted-token>', ['project', 'token']],
    ['a home path', 'example-project/Users/jdoe/x', '<project>~/x', ['project', 'home-path']],
    ['a home path after a user noun', 'example-user/home/jdoe/x', '<user>~/x', ['user', 'home-path']],
    ['a token after a home path', '/Users/jdoe/' + SK, '~/<redacted-token>', ['home-path', 'token']],
  ])('redacts %s glued to a noun, with exact marks', (_name, text, expected, kinds) => {
    const result = redactText(text, KEYS);
    expect(result.text).toBe(expected);
    expect(result.marks.map((mark) => mark.kind)).toEqual(kinds);
    expectExactMarks(result);
  });

  it('reports the marks of both passes at their final positions', () => {
    const result = redactText(`a example-user b example-project${SK} c ${BEARER}`, KEYS);
    expect(result.text).toBe('a <user> b <project><redacted-token> c <redacted-token>');
    expect(result.marks).toEqual([
      { kind: 'user', start: 2, end: 8 },
      { kind: 'project', start: 11, end: 20 },
      { kind: 'token', start: 20, end: 36 },
      { kind: 'token', start: 39, end: 55 },
    ]);
  });

  it('does not run a second pass when the first found nothing (the text is returned as is)', () => {
    const text = 'plain ' + SK.replace('sk-', 'sk_');
    expect(redactText(text, KEYS)).toEqual({ text, marks: [] });
  });

  it('drops a second-pass match that sits inside a first-pass placeholder (a noun named like the placeholder)', () => {
    const prepared = prepareKeys({
      projectRoots: [],
      properNouns: [
        { category: 'project', value: 'project' },
        { category: 'user', value: 'redacted' },
        { category: 'host', value: 'email' },
      ],
    });
    const result = redactText(`project email ${'ghp_' + 'x'.repeat(36)} user@example.com`, prepared);
    expect(result.text).toBe('<project> <host> <redacted-token> <email>');
    expectExactMarks(result);
  });

  it('merges a second-pass match that straddles a first-pass placeholder into one mark', () => {
    // 2 回目の文字列 "<project>ab-user" の "ct>ab-user" は、1 回目の印 "<project>" の終わりにまたがる。
    const prepared = prepareKeys({
      projectRoots: [],
      properNouns: [
        { category: 'project', value: 'example-project' },
        { category: 'user', value: 'ct>ab-user' },
      ],
    });
    const result = redactText('example-projectab-user', prepared);
    expect(result).toEqual({ text: '<project>', marks: [{ kind: 'project', start: 0, end: 9 }] });
  });

  it('handles a chain of two glued neighbours in two passes', () => {
    const result = redactText('example-project' + 'example-user' + SK, KEYS);
    expect(result.text).toBe('<project><user><redacted-token>');
    expectExactMarks(result);
  });

  it('stops after two passes: a third glued link is left to the final net (which reports it)', () => {
    // 1 回目: 名前 2 つ → 2 回目: sk- のトークン → 3 回目でないと見えない: トークンの直後に貼り付いた /Users/…
    const result = redactText('example-project' + 'example-user' + SK + '/Users/jdoe/x', KEYS);
    expect(result.text).toBe('<project><user><redacted-token>/Users/jdoe/x');
    expectExactMarks(result);
  });
});

describe('elide', () => {
  const label = (count: number): string => `[${String(count)}]`;

  it('returns the text unchanged when it fits', () => {
    const value = redactText('abc example-user', KEYS);
    expect(elide(value, 10, 10, label)).toBe(value);
    expect(elide({ text: 'abcd', marks: [] }, 2, 2, label).text).toBe('abcd');
  });

  it('keeps head and tail by code points and reports the omitted code point count', () => {
    expect(elide({ text: '0123456789', marks: [] }, 3, 2, label)).toEqual({ text: '012[5]89', marks: [] });
    expect(elide({ text: '0123456789', marks: [] }, 3, 0, label)).toEqual({ text: '012[7]', marks: [] });
    expect(elide({ text: '0123456789', marks: [] }, 0, 3, label)).toEqual({ text: '[7]789', marks: [] });
  });

  it('moves a head or tail cut that falls inside a mark to the mark boundary', () => {
    const value = { text: 'abc<redacted-token>xyz', marks: [{ kind: 'token' as const, start: 3, end: 19 }] };
    expect(elide(value, 5, 0, label)).toEqual({ text: 'abc[19]', marks: [] });
    expect(elide(value, 0, 5, label)).toEqual({ text: '[19]xyz', marks: [] });
    expect(elide(value, 4, 4, label)).toEqual({ text: 'abc[16]xyz', marks: [] });
  });

  it('shifts the marks that survive after the omitted middle', () => {
    const redacted = redactText(`${'a'.repeat(30)} example-user ${'b'.repeat(30)} example-host`, KEYS);
    const result = elide(redacted, 5, 20, label);
    expectExactMarks(result);
    expect(result.marks.map((mark) => mark.kind)).toEqual(['host']);
    expect(result.text.startsWith('aaaaa[')).toBe(true);
  });

  it('redacts a token that straddles the 1000-code-point cut before cutting', () => {
    const token = 'ghp_' + 'x'.repeat(36);
    const redacted = redactText(`${'a'.repeat(990)}${token} ${'b'.repeat(2_000)}`, EMPTY);
    expect(redacted.text.length).toBe(990 + 16 + 1 + 2_000);
    // 先頭の切れ目 (1000) は印 [990, 1006) の内側。印の始まりまで戻り、印は省略側に入る。トークンの断片は残らない。
    const head = elide(redacted, 1000, 1000, label);
    expect(head.text).not.toMatch(/ghp_|xxxx/);
    expect(head.text.startsWith(`${'a'.repeat(990)}[`)).toBe(true);
    expect(head.marks).toEqual([]);
    expectExactMarks(head);
    // 末尾側の切れ目が印の内側に落ちる場合も、印の終わりまで進む。
    const tailRedacted = redactText(`${'b'.repeat(2_000)} ${token} ${'a'.repeat(990)}`, EMPTY);
    const tail = elide(tailRedacted, 1000, 1000, label);
    expect(tail.text).not.toMatch(/ghp_|xxxx/);
    expect(tail.text.endsWith(` ${'a'.repeat(990)}`)).toBe(true);
    expectExactMarks(tail);
  });

  describe('a range to avoid (a match that the last net would report) is never cut into a fragment', () => {
    const glued = 'id1sk-proj-' + 'x'.repeat(40);
    const avoidAt = (start: number, end: number) => () => [{ start, end }];

    it('moves a head cut inside the range back to the start of the range', () => {
      const value = { text: `${'h'.repeat(975)} ${glued}\n${'m'.repeat(200)}`, marks: [] };
      const start = 976;
      const result = elide(value, 985, 0, label, avoidAt(start, start + glued.length));
      expect(result.text).not.toContain('sk-');
      expect(result.text.startsWith(`${'h'.repeat(975)} [`)).toBe(true);
    });

    it('moves a tail cut inside the range forward to the end of the range', () => {
      const text = `${'m'.repeat(200)}\n${glued} ${'t'.repeat(30)}`;
      const start = 201;
      const result = elide({ text, marks: [] }, 0, 50, label, avoidAt(start, start + glued.length));
      expect(result.text).not.toContain('sk-');
      expect(result.text.endsWith(` ${'t'.repeat(30)}`)).toBe(true);
    });

    it('does not ask for the ranges when the text fits', () => {
      let asked = 0;
      elide({ text: 'short', marks: [] }, 10, 10, label, () => {
        asked += 1;
        return [];
      });
      expect(asked).toBe(0);
    });

    it('treats overlapping ranges and marks as one barrier', () => {
      const token = 'ghp_' + 'x'.repeat(36);
      const redacted = redactText(`${'a'.repeat(20)}${token} ${'b'.repeat(20)}`, EMPTY);
      expect(redacted.marks).toEqual([{ kind: 'token', start: 20, end: 36 }]);
      // 印は [20, 36)。避ける範囲は [30, 45) (印の途中から外へ)。切れ目 40 は避ける範囲の内側 → 和集合の始まり 20 まで戻る。
      const result = elide(redacted, 40, 0, label, avoidAt(30, 45));
      expect(result.text).toBe(`${'a'.repeat(20)}[${String(redacted.text.length - 20)}]`);
      expect(result.marks).toEqual([]);
    });
  });

  it('does not split a surrogate pair or a placeholder at any head/tail length', () => {
    const text = `😀a😀 example-user 😀b😀 ${'ghp_' + 'x'.repeat(36)} 😀c😀 example-host 😀`;
    const redacted = redactText(text, KEYS);
    for (let head = 0; head <= 30; head += 1) {
      for (let tail = 0; tail <= 30; tail += 1) {
        const result = elide(redacted, head, tail, label);
        expectExactMarks(result);
        expect(result.text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
        expect(result.text).not.toMatch(/<redacted-tok(?!en>)|<use(?!r>)|<hos(?!t>)/);
      }
    }
  });
});
