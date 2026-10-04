import { describe, expect, it } from 'vitest';
import { TOKEN_SHAPES, findEmailSpans, findPrivateKeySpans, findTokenSpans } from './issue-public-secrets.js';

// トークンは明らかに偽の値を実行時に組み立てる (リポジトリにシークレットスキャナが反応する文字列を置かない)。
const BEGIN = '-----' + 'BEGIN PRIVATE KEY' + '-----';
const END = '-----' + 'END PRIVATE KEY' + '-----';
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
  ['AWS long-term', () => 'AKIA' + 'X'.repeat(16)],
  ['AWS STS', () => 'ASIA' + 'X'.repeat(16)],
  ['Slack', () => 'xoxb-' + '0'.repeat(20)],
  ['Google', () => 'AIza' + 'x'.repeat(35)],
  ['npm', () => 'npm_' + 'x'.repeat(36)],
  ['Bearer', () => 'Bearer ' + 'x'.repeat(24)],
  ['bearer (lower case, tab, base64 padding)', () => 'bearer\t' + 'x'.repeat(24) + '=='],
];

function spanTexts(text: string, spans: readonly { start: number; end: number }[]): string[] {
  return spans.map((span) => text.slice(span.start, span.end));
}

describe('token shapes', () => {
  it('has a table entry for every family', () => {
    expect(TOKEN_SHAPES.map(({ name }) => name)).toEqual([
      'github',
      'github-fine-grained',
      'sk-family',
      'aws-access-key-id',
      'slack',
      'google-api-key',
      'npm',
      'bearer',
    ]);
  });

  it.each(SHAPES)('finds the whole %s token in running text, leaving nothing of it behind', (_name, make) => {
    const token = make();
    for (const [before, after] of [[' ', ' '], ['key="', '";'], ['(', ').'], ['', ''], ['x=', '\nnext']]) {
      const text = `${before ?? ''}${token}${after ?? ''}`;
      expect(spanTexts(text, findTokenSpans(text))).toEqual([token]);
    }
  });

  it('finds several tokens in one text, each in full', () => {
    const [a, b, c] = [SHAPES[0]?.[1]() ?? '', SHAPES[10]?.[1]() ?? '', SHAPES[7]?.[1]() ?? ''];
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
    ['lower-case akia', 'akia' + 'x'.repeat(16)],
    ['short npm_', 'npm_' + 'x'.repeat(35)],
    ['short AIza', 'AIza' + 'x'.repeat(34)],
    ['short xox', 'xoxb-' + '0'.repeat(9)],
    ['short Bearer value', 'Bearer ' + 'x'.repeat(15)],
    ['Bearer prose', 'Bearer authentication is required'],
  ])('does not mistake %s for a token', (_name, text) => {
    expect(findTokenSpans(text)).toEqual([]);
  });

  it('keeps an sk- key whole when it contains underscores and hyphens', () => {
    const token = 'sk-proj-' + 'ab_-'.repeat(12);
    expect(spanTexts(token, findTokenSpans(token))).toEqual([token]);
  });
});

describe('private key blocks', () => {
  const block = (label: string) => `-----${'BEGIN'} ${label}-----\n${'x'.repeat(64)}\n-----${'END'} ${label}-----`;

  it.each(['RSA PRIVATE KEY', 'EC PRIVATE KEY', 'OPENSSH PRIVATE KEY', 'ENCRYPTED PRIVATE KEY', 'PRIVATE KEY'])(
    'finds a terminated %s block from BEGIN to END',
    (label) => {
      const text = `before\n${block(label)}\nafter`;
      expect(spanTexts(text, findPrivateKeySpans(text))).toEqual([block(label)]);
    },
  );

  it('runs an unterminated block to the end of the text (truncated log)', () => {
    const text = `log\n${BEGIN}\n${'x'.repeat(64)}\ntruncated`;
    expect(findPrivateKeySpans(text)).toEqual([{ start: 4, end: text.length }]);
  });

  it('finds two separate blocks and does not swallow the text between them', () => {
    const text = `${block('RSA PRIVATE KEY')}\nbetween\n${block('EC PRIVATE KEY')}`;
    expect(spanTexts(text, findPrivateKeySpans(text))).toEqual([block('RSA PRIVATE KEY'), block('EC PRIVATE KEY')]);
  });

  it('ignores public keys and an END with no BEGIN', () => {
    expect(findPrivateKeySpans('-----' + 'BEGIN PUBLIC KEY' + '-----\nabc\n-----' + 'END PUBLIC KEY' + '-----')).toEqual([]);
    expect(findPrivateKeySpans(END)).toEqual([]);
  });

  it('closes a BEGIN that sits right behind another BEGIN at the first END', () => {
    const text = `${BEGIN}\n${BEGIN}\nx\n${END}\ntail`;
    expect(spanTexts(text, findPrivateKeySpans(text))).toEqual([`${BEGIN}\n${BEGIN}\nx\n${END}`]);
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

  it.each(['@example-user mention', 'user@localhost', 'a@b', 'foo @ bar.com', 'no at sign.example.com'])(
    'does not treat %j as an address',
    (text) => {
      expect(findEmailSpans(text)).toEqual([]);
    },
  );
});

describe('linear time on hostile 100k inputs', () => {
  it('scans every finder in well under three seconds', () => {
    const hostile = [
      'a'.repeat(100_000),
      'a@'.repeat(50_000),
      'sk-'.repeat(33_000),
      'ghp_'.repeat(25_000),
      'Bearer '.repeat(14_000),
      BEGIN.repeat(3_000),
      END.repeat(3_000),
      '/'.repeat(100_000),
      'eyJ'.repeat(30_000),
      'a.'.repeat(50_000),
      'x@' + 'a.'.repeat(50_000),
      ('a@b' + 'b'.repeat(50)).repeat(1_800),
      '-----BEGIN' + ' '.repeat(100_000),
      'Bearer' + ' '.repeat(100_000),
      String.fromCharCode(0xd83d).repeat(100_000),
      '😀'.repeat(50_000),
      'AKIA'.repeat(25_000),
      'github_pat_'.repeat(9_000),
    ];
    const started = performance.now();
    for (const value of hostile) {
      findTokenSpans(value);
      findPrivateKeySpans(value);
      findEmailSpans(value);
    }
    expect(performance.now() - started).toBeLessThan(3000);
  });
});
