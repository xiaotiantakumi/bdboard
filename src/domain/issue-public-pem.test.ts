import { describe, expect, it } from 'vitest';
import { findKeyBlockSpans } from './issue-public-pem.js';

// 鍵の印は実行時に組み立てる (リポジトリにシークレットスキャナが反応する文字列を置かない)。
const BEGIN = '-----' + 'BEGIN PRIVATE KEY' + '-----';
const END = '-----' + 'END PRIVATE KEY' + '-----';
const BODY = 'Q'.repeat(64);

function spanTexts(text: string): string[] {
  return findKeyBlockSpans(text).map((span) => text.slice(span.start, span.end));
}

describe('private key blocks', () => {
  const block = (label: string) => `-----${'BEGIN'} ${label}-----\n${'x'.repeat(64)}\n-----${'END'} ${label}-----`;

  it.each(['RSA PRIVATE KEY', 'EC PRIVATE KEY', 'OPENSSH PRIVATE KEY', 'ENCRYPTED PRIVATE KEY', 'PRIVATE KEY'])(
    'finds a terminated %s block from BEGIN to END',
    (label) => {
      const text = `before\n${block(label)}\nafter`;
      expect(spanTexts(text)).toEqual([block(label)]);
    },
  );

  it('runs an unterminated block to the end of the text (truncated log)', () => {
    const text = `log\n${BEGIN}\n${BODY}\ntruncated`;
    expect(findKeyBlockSpans(text)).toEqual([{ start: 4, end: text.length }]);
  });

  it('finds two separate blocks and does not swallow the text between them', () => {
    const text = `${block('RSA PRIVATE KEY')}\nbetween\n${block('EC PRIVATE KEY')}`;
    expect(spanTexts(text)).toEqual([block('RSA PRIVATE KEY'), block('EC PRIVATE KEY')]);
  });

  it('ignores public keys', () => {
    expect(findKeyBlockSpans('-----' + 'BEGIN PUBLIC KEY' + '-----\nabc\n-----' + 'END PUBLIC KEY' + '-----')).toEqual([]);
  });

  it('closes a BEGIN that sits right behind another BEGIN at the first END', () => {
    const text = `${BEGIN}\n${BEGIN}\nx\n${END}\ntail`;
    expect(spanTexts(text)).toEqual([`${BEGIN}\n${BEGIN}\nx\n${END}`]);
  });
});

describe('an END marker without a BEGIN (a log captured from its last N lines)', () => {
  it('redacts from the start of the text to the END', () => {
    const text = `MIIEowIBAAKCAQEA${BODY}\n${END}\nafter`;
    expect(findKeyBlockSpans(text)).toEqual([{ start: 0, end: text.indexOf(END) + END.length }]);
  });

  it('starts an orphan END after the previous block, not at the start of the text', () => {
    const first = `${BEGIN}\nx\n${END}`;
    const text = `${first}\nmiddle ${BODY}\n${END}\nafter`;
    expect(findKeyBlockSpans(text)).toEqual([
      { start: 0, end: first.length },
      { start: first.length, end: text.indexOf(END, first.length) + END.length },
    ]);
  });

  it('reports the lone marker itself (a marker is always inside some span)', () => {
    for (const text of [END, `a ${END} b`, `a ${BEGIN} b`, `${END}${BEGIN}`]) {
      const spans = findKeyBlockSpans(text);
      for (const marker of [BEGIN, END]) {
        const at = text.indexOf(marker);
        if (at < 0) continue;
        expect(spans.some((span) => span.start <= at && at + marker.length <= span.end)).toBe(true);
      }
    }
  });
});

describe('other private key formats', () => {
  it('matches lower-case markers', () => {
    const text = `-----${'begin rsa private key'}-----\n${BODY}\n-----${'end rsa private key'}-----`;
    expect(spanTexts(text)).toEqual([text]);
  });

  it('matches a lower-case BEGIN that has no END at all, and runs to the end of the text', () => {
    // 終わりの印が無い切り詰めのログ。BEGIN の大文字小文字を区別する変更は、ここでだけ落ちる (END の行があると孤立 END の規則が救う)。
    const text = `before\n-----${'begin rsa private key'}-----\n${BODY}`;
    expect(findKeyBlockSpans(text)).toEqual([{ start: 7, end: text.length }]);
    const mixed = `before\n-----${'Begin Private Key'}-----\n${BODY}`;
    expect(findKeyBlockSpans(mixed)).toEqual([{ start: 7, end: mixed.length }]);
  });

  it('matches a lower-case END that has no BEGIN', () => {
    const text = `${BODY}\n-----${'end rsa private key'}-----\nafter`;
    expect(spanTexts(text)).toEqual([`${BODY}\n-----${'end rsa private key'}-----`]);
  });

  it.each([
    ['three dashes', `---${'BEGIN RSA PRIVATE KEY'}---`, `---${'END RSA PRIVATE KEY'}---`],
    ['three dashes and spaces', `--- ${'BEGIN PRIVATE KEY'} ---`, `--- ${'END PRIVATE KEY'} ---`],
    ['a hyphen in the label', `-----${'BEGIN EC-X PRIVATE KEY'}-----`, `-----${'END EC-X PRIVATE KEY'}-----`],
    ['a hyphen in the label and three dashes', `---${'BEGIN SSH-2 PRIVATE KEY'}---`, `---${'END SSH-2 PRIVATE KEY'}---`],
  ])('matches %s', (_name, begin, end) => {
    const text = `a\n${begin}\n${BODY}\n${end}\nb`;
    expect(spanTexts(text)).toEqual([`${begin}\n${BODY}\n${end}`]);
    // 終わりの印が無い切り詰めでも、本体まで消える。
    expect(findKeyBlockSpans(`a\n${begin}\n${BODY}`)).toEqual([{ start: 2, end: 2 + begin.length + 1 + BODY.length }]);
  });

  it('does not take two dashes or a public key for a private key marker', () => {
    expect(findKeyBlockSpans(`--${'BEGIN PRIVATE KEY'}--\n${BODY}`)).toEqual([]);
    expect(findKeyBlockSpans(`---${'BEGIN PUBLIC KEY'}---\n${BODY}`)).toEqual([]);
  });

  it('matches the SSH2 form with four dashes and spaces', () => {
    const text = `---- ${'BEGIN SSH2 ENCRYPTED PRIVATE KEY'} ----\n${BODY}\n---- ${'END SSH2 ENCRYPTED PRIVATE KEY'} ----`;
    expect(spanTexts(text)).toEqual([text]);
  });

  it('matches a PuTTY key file header and runs to the end of the text', () => {
    const text = `log\nPuTTY-User-Key-File-3: ssh-ed25519\nPrivate-Lines: 1\n${BODY}\nPrivate-MAC: ${BODY}`;
    expect(findKeyBlockSpans(text)).toEqual([{ start: 4, end: text.length }]);
  });

  it('matches a PGP private key block', () => {
    const text = `-----${'BEGIN PGP PRIVATE KEY BLOCK'}-----\n${BODY}\n-----${'END PGP PRIVATE KEY BLOCK'}-----`;
    expect(spanTexts(text)).toEqual([text]);
  });

  it('finds the block inside JSON-escaped text', () => {
    const text = `{"k":"${BEGIN}\\n${BODY}\\n${END}\\n"}`;
    expect(spanTexts(text)).toEqual([`${BEGIN}\\n${BODY}\\n${END}`]);
  });
});

describe('linear time on hostile 100k inputs', () => {
  it('scans repeated and swapped markers in well under three seconds', () => {
    const hostile = [
      BEGIN.repeat(3_000),
      END.repeat(3_000),
      `${END}${BEGIN}`.repeat(1_500),
      '-----BEGIN' + ' '.repeat(100_000),
      '-----BEGIN '.repeat(9_000),
      '-'.repeat(100_000),
      '---- BEGIN '.repeat(8_000),
      'PuTTY-User-Key-File-'.repeat(5_000),
      '-----BEGIN ' + 'A '.repeat(50_000),
      '---BEGIN '.repeat(11_000),
      '---BEGIN ' + 'A-'.repeat(50_000),
      '---BEGIN ' + 'A-A'.repeat(33_000) + ' PRIVATE KEY',
      '-'.repeat(50_000) + 'BEGIN ' + '-'.repeat(50_000),
    ];
    const started = performance.now();
    for (const value of hostile) findKeyBlockSpans(value);
    expect(performance.now() - started).toBeLessThan(3000);
  });
});
