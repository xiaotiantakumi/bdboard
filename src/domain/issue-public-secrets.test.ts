import { describe, expect, it } from 'vitest';
import { TOKEN_SHAPES, findEmailSpans, findTokenSpans } from './issue-public-secrets.js';
import { LINEAR_TIME_TEST_TIMEOUT_MS, expectLinearTime } from './linear-time-test-support.js';

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

  it.each([
    '@example-user mention',
    'user@localhost',
    'a@b',
    'foo @ bar.com',
    'no at sign.example.com',
    '100%40 sure',
    // パッケージの版 (最後のラベルが数字だけ): 版の情報を消さない。
    'react@18.2.0',
    'typescript@5.6.3',
    '@types+node@22.1.0',
    'vitest@4.1.11-beta.2.3',
    'react@19.0.0-rc.1',
    'pkg@2.0.0-beta.1',
    'pkg@v2.0.1',
    'pnpm@9.0',
  ])('does not treat %j as an address', (text) => {
    expect(findEmailSpans(text)).toEqual([]);
  });

  it('needs the last label to start with a letter, not every label', () => {
    for (const address of ['icon@2x.png', 'user@123.example.com', 'a@b-1.c2', 'user@例え.テスト', 'user@xn--abc.xn--def']) {
      expect(spanTexts(address, findEmailSpans(address))).toEqual([address]);
    }
  });

  it('takes the digit-only labels after the last letter-led label into the address (no "<email>.1" remnant, no silent address)', () => {
    for (const address of ['a@b.c1.2', 'a@b.com.9', 'jdoe@example.com.1', 'jdoe@example.com.2024', 'jdoe@example.com.0.1']) {
      expect(spanTexts(address, findEmailSpans(address))).toEqual([address]);
      const sentence = `to ${address} failed`;
      expect(spanTexts(sentence, findEmailSpans(sentence))).toEqual([address]);
    }
    // 終わりの "." はドメインに入れない。
    expect(spanTexts('mail jdoe@example.com.', findEmailSpans('mail jdoe@example.com.'))).toEqual(['jdoe@example.com']);
  });

  it('still leaves a package version alone when no label after the first one starts with a letter', () => {
    for (const text of ['react@19.0.0-rc.1', 'react@18.2.0', 'typescript@5.6.3', 'vitest@4.1.11', '@types+node@22.1.0', 'pkg@2.0.0-beta.1']) {
      expect(findEmailSpans(text)).toEqual([]);
    }
  });

  it('still finds an ssh target written with an IPv4 address (digits only, four parts)', () => {
    expect(spanTexts('ssh deploy@10.0.0.5 -p 22', findEmailSpans('ssh deploy@10.0.0.5 -p 22'))).toEqual(['deploy@10.0.0.5']);
    expect(spanTexts('deploy@192.168.1.5.', findEmailSpans('deploy@192.168.1.5.'))).toEqual(['deploy@192.168.1.5']);
    // 3 つ以下、または桁が多い数字の連なりは版として読む。
    expect(findEmailSpans('deploy@10.0.5')).toEqual([]);
    expect(findEmailSpans('chromium@120.0.6099.109')).toEqual([]);
  });

  it('does not cut an IPv4 target out of a longer number or word (what may follow the last octet)', () => {
    // 最後の 8 進数の後ろに数字・文字・ハイフンが続くときは、IPv4 とは読まない ("<email>4" のように断片を残さない)。
    for (const text of ['deploy@10.0.0.1234', 'deploy@10.0.0.5x', 'deploy@10.0.0.5-x']) {
      expect(findEmailSpans(text)).toEqual([]);
    }
    // ポート・パス・句読点・空白は IPv4 のあとに続いてよい。
    for (const suffix of [':22', '/srv', ',', ';', ' x']) {
      const text = `deploy@10.0.0.5${suffix}`;
      expect(spanTexts(text, findEmailSpans(text))).toEqual(['deploy@10.0.0.5']);
    }
  });
});

describe('Stripe and JWT glued to other characters (reported by the loose mode, not replaced)', () => {
  const stripe = 'sk_live_' + 'x'.repeat(30);
  const jwt = 'eyJ' + 'a'.repeat(20) + '.eyJ' + 'b'.repeat(20) + '.' + 'c'.repeat(20);
  const tail = '.eyJ' + 'b'.repeat(20) + '.' + 'c'.repeat(20);

  it('does not replace a Stripe key or a JWT that sits inside a word', () => {
    for (const text of ['key1' + stripe, 'id1' + jwt, 'id_' + jwt, 'id-' + jwt]) {
      expect(findTokenSpans(text)).toEqual([]);
    }
  });

  it('reports the glued Stripe key in full and the glued JWT from its second part', () => {
    expect(spanTexts('key1' + stripe, findTokenSpans('key1' + stripe, true))).toEqual([stripe]);
    for (const prefix of ['id1', 'id_', 'id-']) {
      expect(spanTexts(prefix + jwt, findTokenSpans(prefix + jwt, true))).toEqual([tail]);
    }
  });

  it('does not report a lone JWT header or a short second part', () => {
    expect(findTokenSpans('id1eyJ' + 'a'.repeat(20) + '.x', true)).toEqual([]);
    expect(findTokenSpans('a.eyJ' + 'b'.repeat(20), true)).toEqual([]);
  });
});

describe('linear time on hostile 100k inputs', () => {
  // bdboard-0101: 壁時計の絶対値 (3000ms) ではなく、同じ形を 1/10 の長さと元の長さで測った比で線形を見る。
  it('scans every finder (strict and loose) in time linear in the input length', () => {
    expectLinearTime('issue-public-secrets: hostile 100k inputs', (n) => {
      const hostile = [
        'a'.repeat(n(100_000)),
        'a@'.repeat(n(50_000)),
        'a%40'.repeat(n(25_000)),
        'sk-'.repeat(n(33_000)),
        'sk-' + 'a'.repeat(n(100_000)),
        'ghp_'.repeat(n(25_000)),
        'Bearer '.repeat(n(14_000)),
        'Bearer%20'.repeat(n(11_000)),
        'eyJ'.repeat(n(33_000)),
        ('eyJ' + 'a'.repeat(10) + '.').repeat(n(7_000)),
        'eyJaaaaaaaaa.eyJaaaaaaaaa'.repeat(n(4_000)),
        '\\n'.repeat(n(50_000)),
        '%0A'.repeat(n(33_000)),
        'a.'.repeat(n(50_000)),
        'x@' + 'a.'.repeat(n(50_000)),
        ('a@b' + 'b'.repeat(50)).repeat(n(1_800)),
        'Bearer' + ' '.repeat(n(100_000)),
        String.fromCharCode(0xd83d).repeat(n(100_000)),
        '😀'.repeat(n(50_000)),
        'AKIA'.repeat(n(25_000)),
        'akia'.repeat(n(25_000)),
        'github_pat_'.repeat(n(9_000)),
        'sk_live_'.repeat(n(12_000)),
        'xapp-'.repeat(n(20_000)),
        'ya29.'.repeat(n(20_000)),
        'x@' + '1.'.repeat(n(50_000)),
        'x@' + 'a1.'.repeat(n(33_000)),
        'x@' + '1.'.repeat(n(50_000)) + 'a',
        'x@10.0.0.' + '1'.repeat(n(100_000)),
        'a@b' + '.c.1'.repeat(n(25_000)),
        'x@a.b' + '.1'.repeat(n(50_000)),
        ('a@b.1.' + 'x'.repeat(10) + '.').repeat(n(6_000)),
        '.eyJ'.repeat(n(25_000)),
        '.eyJaaaaaaaa'.repeat(n(7_000)),
        ('.eyJaaaaaaaa.' + 'b'.repeat(7)).repeat(n(5_000)),
        'k_live_' + 'x'.repeat(n(100_000)),
      ];
      return () => {
        for (const value of hostile) {
          findTokenSpans(value);
          findTokenSpans(value, true);
          findEmailSpans(value);
        }
      };
    });
  }, LINEAR_TIME_TEST_TIMEOUT_MS);
});
