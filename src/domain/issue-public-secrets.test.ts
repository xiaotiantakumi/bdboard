import { describe, expect, it } from 'vitest';
import { TOKEN_SHAPES, findEmailSpans, findTokenSpans } from './issue-public-secrets.js';

// トークンは明らかに偽の値を実行時に組み立てる (リポジトリにシークレットスキャナが反応する文字列を置かない)。
const SHAPES: readonly (readonly [string, () => string])[] = [
  ['github', () => 'ghp_' + 'x'.repeat(36)],
  ['github OAuth', () => 'gho_' + 'x'.repeat(36)],
  ['github user-to-server', () => 'ghu_' + 'x'.repeat(36)],
  ['github server-to-server', () => 'ghs_' + 'x'.repeat(36)],
  ['github refresh', () => 'ghr_' + 'x'.repeat(36)],
  ['github fine-grained', () => 'github_pat_' + 'x'.repeat(30)],
  ['OpenAI legacy', () => 'sk-' + 'x'.repeat(40)],
  ['OpenAI project (with _ and -)', () => 'sk-proj-' + 'ab_-'.repeat(12)],
  ['OpenAI service account', () => 'sk-svcacct-' + 'ab_-'.repeat(12)],
  ['Anthropic', () => 'sk-ant-' + 'x'.repeat(40)],
  ['Stripe secret', () => 'sk_live_' + 'x'.repeat(24)],
  ['Stripe restricted', () => 'rk_live_' + 'x'.repeat(24)],
  ['AWS long-term', () => 'AKIA' + 'X'.repeat(16)],
  ['AWS STS', () => 'ASIA' + 'X'.repeat(16)],
  ['Slack bot', () => 'xoxb-' + '0'.repeat(20)],
  ['Slack app-level', () => 'xapp-1-' + 'A'.repeat(30)],
  ['Google API key', () => 'AIza' + 'x'.repeat(35)],
  ['Google OAuth', () => 'ya29.' + 'x'.repeat(30)],
  ['npm', () => 'npm_' + 'x'.repeat(36)],
  ['JWT', () => 'eyJ' + 'a'.repeat(20) + '.eyJ' + 'b'.repeat(20) + '.' + 'c'.repeat(20)],
  ['Bearer', () => 'Bearer ' + 'x'.repeat(24)],
  ['bearer (lower case, tab, base64 padding)', () => 'bearer\t' + 'x'.repeat(24) + '=='],
  ['Bearer with a %20 separator', () => 'Bearer%20' + 'x'.repeat(24)],
];
const SK = 'sk-proj-' + 'x'.repeat(40);
const BEARER = 'Bearer ' + 'y'.repeat(30);

function spanTexts(text: string, spans: readonly { start: number; end: number }[]): string[] {
  return spans.map((span) => text.slice(span.start, span.end));
}

describe('token shapes', () => {
  it('has a table entry for every family', () => {
    expect(TOKEN_SHAPES.map(({ name }) => name)).toEqual([
      'github',
      'github-fine-grained',
      'sk-family',
      'stripe',
      'aws-access-key-id',
      'slack',
      'google-api-key',
      'google-oauth',
      'npm',
      'jwt',
      'bearer',
    ]);
  });

  it.each(SHAPES)('finds the whole %s token in running text, leaving nothing of it behind', (_name, make) => {
    const token = make();
    for (const [before, after] of [[' ', ' '], ['key="', '";'], ['(', ').'], ['', ''], ['x=', '\nnext']]) {
      const text = `${before ?? ''}${token}${after ?? ''}`;
      expect(spanTexts(text, findTokenSpans(text))).toEqual([token]);
      expect(spanTexts(text, findTokenSpans(text, true))).toEqual([token]);
    }
  });

  it('finds several tokens in one text, each in full', () => {
    const [a, b, c] = [SHAPES[0]?.[1]() ?? '', SHAPES[12]?.[1]() ?? '', SHAPES[20]?.[1]() ?? ''];
    const text = `${a} ${b},${c}`;
    expect(spanTexts(text, findTokenSpans(text)).sort()).toEqual([a, b, c].sort());
  });

  it.each([
    ['task-force prose (sk- inside a word)', 'task-force-coordination-with-a-very-long-team-name'],
    ['risk-assessment prose', 'risk-assessment-for-the-whole-platform-team'],
    ['short sk-', 'sk-short'],
    ['short ghp_', 'ghp_' + 'x'.repeat(19)],
    ['short github_pat_', 'github_pat_' + 'x'.repeat(19)],
    ['short AKIA', 'AKIA' + 'X'.repeat(15)],
    ['lower-case akia (strict mode)', 'akia' + 'x'.repeat(16)],
    ['short npm_', 'npm_' + 'x'.repeat(35)],
    ['short AIza', 'AIza' + 'x'.repeat(34)],
    ['short xox', 'xoxb-' + '0'.repeat(9)],
    ['short Bearer value', 'Bearer ' + 'x'.repeat(15)],
    ['Bearer prose', 'Bearer authentication is required'],
    ['short Stripe key', 'sk_live_' + 'x'.repeat(15)],
    ['short ya29', 'ya29.' + 'x'.repeat(19)],
    ['two-part JWT', 'eyJ' + 'a'.repeat(20) + '.eyJ' + 'b'.repeat(20)],
    ['a word ending in Bearer', 'pallBearer ' + 'x'.repeat(24)],
  ])('does not mistake %s for a token', (_name, text) => {
    expect(findTokenSpans(text)).toEqual([]);
  });

  it('keeps an sk- key whole when it contains underscores and hyphens', () => {
    const token = 'sk-proj-' + 'ab_-'.repeat(12);
    expect(spanTexts(token, findTokenSpans(token))).toEqual([token]);
  });
});

describe('sk- and Bearer after escapes (they used to be skipped silently)', () => {
  it.each([
    ['a JSON \\n escape', '{"out":"line1\\n' + SK + '"}', SK],
    ['a JSON \\t escape', '"a\\t' + SK + '"', SK],
    ['a JSON \\r escape', '"a\\r' + SK + '"', SK],
    ['a %3D (urlencoded =)', 'GET /x?key%3D' + SK, SK],
    ['a %20 (urlencoded space)', 'q=Bearer%20' + SK, SK],
    ['a JSON \\n escape before Bearer', '"x\\n' + BEARER + '"', BEARER],
    ['a %0A before Bearer', 'x%0A' + BEARER, BEARER],
    ['a %20 before a Bearer value', 'q=Bearer%20' + 'y'.repeat(30), 'Bearer%20' + 'y'.repeat(30)],
  ])('finds the token after %s', (_name, text, secret) => {
    expect(spanTexts(text, findTokenSpans(text))).toContain(secret);
  });

  it('still spares prose where sk- or Bearer sit inside a word', () => {
    expect(findTokenSpans('task-force-' + 'x'.repeat(30))).toEqual([]);
    expect(findTokenSpans('risk-' + 'x'.repeat(30))).toEqual([]);
    expect(findTokenSpans('pallBearer ' + 'y'.repeat(30))).toEqual([]);
  });

  it('reports glued sk- and Bearer in the loose (report-only) mode only', () => {
    expect(findTokenSpans('id1' + SK)).toEqual([]);
    expect(spanTexts('id1' + SK, findTokenSpans('id1' + SK, true))).toEqual([SK]);
    expect(findTokenSpans('x' + BEARER)).toEqual([]);
    expect(spanTexts('x' + BEARER, findTokenSpans('x' + BEARER, true))).toEqual([BEARER]);
    const lower = 'akia' + 'x'.repeat(16);
    expect(findTokenSpans(lower)).toEqual([]);
    expect(spanTexts(lower, findTokenSpans(lower, true))).toEqual([lower]);
  });

  it('loose mode is a superset: every strict match is found with the same range', () => {
    const text = SHAPES.map(([, make]) => make()).join(' | ');
    const strict = findTokenSpans(text);
    const loose = findTokenSpans(text, true);
    for (const span of strict) expect(loose).toContainEqual(span);
  });
});

describe('regex state is never shared (a caller using .test() cannot hide a token)', () => {
  it('exports only frozen plain data, no live RegExp objects', () => {
    expect(Object.isFrozen(TOKEN_SHAPES)).toBe(true);
    for (const shape of TOKEN_SHAPES) {
      expect(Object.isFrozen(shape)).toBe(true);
      expect(typeof shape.source).toBe('string');
      expect(Object.values(shape).some((value) => value instanceof RegExp)).toBe(false);
    }
  });

  it('finds an early token after another piece of code used a RegExp built from a shape with a far lastIndex', () => {
    const token = 'ghp_' + 'x'.repeat(36);
    const text = 'early ' + token + ' ' + 'pad '.repeat(30);
    const shape = TOKEN_SHAPES.find(({ name }) => name === 'github');
    const regex = new RegExp(shape?.source ?? '', shape?.flags);
    regex.test('z'.repeat(120) + token);
    expect(regex.lastIndex).toBeGreaterThan(100);
    expect(spanTexts(text, findTokenSpans(text))).toEqual([token]);
    expect(spanTexts(text, findTokenSpans(text, true))).toEqual([token]);
    expect(spanTexts(text, findTokenSpans(text))).toEqual([token]);
  });
});

describe('e-mail addresses', () => {
  it('finds ASCII, plus-tagged and non-ASCII addresses once each, without the trailing dot', () => {
    const text = 'a example-user@example.com. b example.user+tag@sub.example.co.jp c 利用者@例え.テスト';
    expect(spanTexts(text, findEmailSpans(text))).toEqual([
      'example-user@example.com',
      'example.user+tag@sub.example.co.jp',
      '利用者@例え.テスト',
    ]);
  });

  it('starts at the beginning of the local part, not in the middle of it', () => {
    const text = 'xx.yy-zz_ww@example.com';
    expect(spanTexts(text, findEmailSpans(text))).toEqual([text]);
  });

  it('finds an address written with a percent-encoded or a full-width at sign', () => {
    const fullWidth = String.fromCodePoint(0xff20);
    for (const at of ['%40', fullWidth]) {
      const address = `example-user${at}example.com`;
      expect(spanTexts(`email=${address}&x=1`, findEmailSpans(`email=${address}&x=1`))).toEqual([address]);
    }
  });

  it.each(['@example-user mention', 'user@localhost', 'a@b', 'foo @ bar.com', 'no at sign.example.com', '100%40 sure'])(
    'does not treat %j as an address',
    (text) => {
      expect(findEmailSpans(text)).toEqual([]);
    },
  );
});

describe('linear time on hostile 100k inputs', () => {
  it('scans every finder (strict and loose) in well under three seconds', () => {
    const hostile = [
      'a'.repeat(100_000),
      'a@'.repeat(50_000),
      'a%40'.repeat(25_000),
      'sk-'.repeat(33_000),
      'sk-' + 'a'.repeat(100_000),
      'ghp_'.repeat(25_000),
      'Bearer '.repeat(14_000),
      'Bearer%20'.repeat(11_000),
      'eyJ'.repeat(33_000),
      ('eyJ' + 'a'.repeat(10) + '.').repeat(7_000),
      'eyJaaaaaaaaa.eyJaaaaaaaaa'.repeat(4_000),
      '\\n'.repeat(50_000),
      '%0A'.repeat(33_000),
      'a.'.repeat(50_000),
      'x@' + 'a.'.repeat(50_000),
      ('a@b' + 'b'.repeat(50)).repeat(1_800),
      'Bearer' + ' '.repeat(100_000),
      String.fromCharCode(0xd83d).repeat(100_000),
      '😀'.repeat(50_000),
      'AKIA'.repeat(25_000),
      'akia'.repeat(25_000),
      'github_pat_'.repeat(9_000),
      'sk_live_'.repeat(12_000),
      'xapp-'.repeat(20_000),
      'ya29.'.repeat(20_000),
    ];
    const started = performance.now();
    for (const value of hostile) {
      findTokenSpans(value);
      findTokenSpans(value, true);
      findEmailSpans(value);
    }
    expect(performance.now() - started).toBeLessThan(3000);
  });
});
