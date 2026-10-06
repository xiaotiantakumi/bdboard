import { readFileSync } from 'node:fs';
import { URL as NodeUrl, fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../api/http';
import { makeExternalList, NO_FINDINGS } from '../../test/externalIssueFixtures';
import {
  BUDGET_EXHAUSTED_DETAIL_PREFIX,
  describeCheckCounts,
  externalStaleNote,
  externalStateMessage,
  formatInvisibleMark,
  isInvisibleCodePoint,
  refreshFailureMessage,
  segmentExternalText,
} from './externalIssueText';

/** bdboard-4y8q.9.5: 届いた issue の表示用の純粋関数。 */

/** jsdom の URL でなく node:url の URL を使う (HygienePanel.badge-colors.test.ts と同じ理由)。web から src は import できないので、文字として読む。 */
function readServerSource(relativePath: string): string {
  return readFileSync(fileURLToPath(new NodeUrl(relativePath, import.meta.url)), 'utf8');
}

const ZWSP = String.fromCodePoint(0x200b);
const RLO = String.fromCodePoint(0x202e);

describe('the set of hidden characters shown as marks', () => {
  it('is the same set as the server-side check, for every code point', () => {
    const source = readServerSource('../../../../src/domain/external-issue-hidden-text.ts');
    // 表 (INVISIBLE_CHARS の配列) だけを切り出す。見つからなければ落とす (名前が変わったのに黙って通らないように)。
    const table = /const INVISIBLE_CHARS\b[^=]*=\s*\[([\s\S]*?)\n\];/.exec(source)?.[1];
    expect(table).toBeDefined();
    // 16 進の大文字・小文字、1 行でも複数行でも読む。
    const rows = [...(table ?? '').matchAll(/\{\s*code:\s*(0x[0-9a-fA-F]+)\s*,(?:\s*last:\s*(0x[0-9a-fA-F]+)\s*,)?/g)];
    // 表の中の `code:` は全部読めていること (定数名や別の書き方の行が混ざったら、読み損ねたまま通さずに落とす)。
    expect(rows).toHaveLength((table ?? '').match(/\bcode\s*:/g)?.length ?? -1);
    // 表の行を読み損ねて空の集合どうしで通ることを防ぐ (表は 17 文字 + タグ文字の範囲 1 つ)。
    expect(rows).toHaveLength(18);
    const server = new Set<number>();
    for (const row of rows) {
      for (let code = Number(row[1]); code <= Number(row[2] ?? row[1]); code += 1) server.add(code);
    }

    const web = new Set<number>();
    for (let code = 0; code <= 0x10ffff; code += 1) {
      if (isInvisibleCodePoint(code)) web.add(code);
    }

    expect(web.size).toBe(server.size);
    expect([...web].filter((code) => !server.has(code))).toEqual([]);
    expect([...server].filter((code) => !web.has(code))).toEqual([]);
  });

  it('uses the same budget-exhausted wording as the server, so the "later" sentence can be picked', () => {
    const source = readServerSource('../../../../src/bootstrap/wire-external-issues.ts');

    expect(source).toContain(`const GH_BUDGET_EXHAUSTED_MESSAGE = \`${BUDGET_EXHAUSTED_DETAIL_PREFIX}:`);
  });
});

describe('formatInvisibleMark', () => {
  it.each([
    [0x200b, '⟦U+200B⟧'],
    [0x061c, '⟦U+061C⟧'],
    [0xfeff, '⟦U+FEFF⟧'],
    [0xe0041, '⟦U+E0041⟧'],
  ])('writes U+%s as a mark', (codePoint, mark) => {
    expect(formatInvisibleMark(codePoint)).toBe(mark);
  });
});

describe('segmentExternalText', () => {
  it('returns nothing for an empty text and one text segment for a plain one', () => {
    expect(segmentExternalText('')).toEqual([]);
    expect(segmentExternalText('plain')).toEqual([{ kind: 'text', text: 'plain' }]);
  });

  it('turns a run of hidden characters (of different kinds) into one mark segment, keeping the other characters', () => {
    expect(segmentExternalText(`a${ZWSP}${RLO}b${ZWSP}`)).toEqual([
      { kind: 'text', text: 'a' },
      { kind: 'invisible', marks: '⟦U+200B⟧⟦U+202E⟧' },
      { kind: 'text', text: 'b' },
      { kind: 'invisible', marks: '⟦U+200B⟧' },
    ]);
  });

  it('reads code points: a tag character (a surrogate pair) is one mark, and a lone surrogate stays as text', () => {
    const tag = String.fromCodePoint(0xe0041);
    expect(segmentExternalText(`x${tag}😀\ud800`)).toEqual([
      { kind: 'text', text: 'x' },
      { kind: 'invisible', marks: '⟦U+E0041⟧' },
      { kind: 'text', text: '😀\ud800' },
    ]);
  });

  it('keeps an HTML comment as characters (the delimiters stay) and marks hidden characters inside it', () => {
    expect(segmentExternalText(`a<!-- b${ZWSP}c -->d`)).toEqual([
      { kind: 'text', text: 'a' },
      {
        kind: 'comment',
        closed: true,
        parts: [
          { kind: 'text', text: '<!-- b' },
          { kind: 'invisible', marks: '⟦U+200B⟧' },
          { kind: 'text', text: 'c -->' },
        ],
      },
      { kind: 'text', text: 'd' },
    ]);
  });

  it('finds every comment, and leaves an unclosed one open to the end of the text', () => {
    const kinds = segmentExternalText('<!-- a --> x <!-- b --> y <!-- c').map((segment) =>
      segment.kind === 'comment' ? `comment:${segment.closed}` : segment.kind,
    );

    expect(kinds).toEqual(['comment:true', 'text', 'comment:true', 'text', 'comment:false']);
  });

  it('does not let <!--> close itself (the same reading as the server-side check)', () => {
    expect(segmentExternalText('<!-->')).toEqual([{ kind: 'comment', closed: false, parts: [{ kind: 'text', text: '<!-->' }] }]);
    expect(segmentExternalText('<!--> x -->')).toEqual([
      { kind: 'comment', closed: true, parts: [{ kind: 'text', text: '<!--> x -->' }] },
    ]);
  });

  it('only replaces hidden characters with marks: every other character comes back unchanged', () => {
    const text = `一行目\n<!-- c -->\t${ZWSP}日本語 😀 <b>tag</b>`;
    const joined = segmentExternalText(text)
      .map((segment) => (segment.kind === 'comment' ? segment.parts : [segment]))
      .flat()
      .map((part) => (part.kind === 'text' ? part.text : ''))
      .join('');

    expect(joined).toBe(text.replace(ZWSP, ''));
  });

  it('finishes a large input of alternating hidden characters (linear time)', () => {
    const segments = segmentExternalText(`x${ZWSP}`.repeat(10_000));

    expect(segments).toHaveLength(20_000);
  });
});

describe('describeCheckCounts', () => {
  it('lists the four counts with no judgment, and shows 0 as 0', () => {
    const counts = describeCheckCounts(NO_FINDINGS);

    expect(counts.map((item) => [item.label, item.count])).toEqual([
      ['見えない文字', 0],
      ['HTML コメント', 0],
      ['長い符号化文字列', 0],
      ['リンク', 0],
    ]);
  });

  it('breaks the hidden characters down by kind (up to five) and says how many more there are', () => {
    const kinds = Array.from({ length: 7 }, (_, index) => ({
      codePoint: `U+200${index}`,
      name: 'X',
      group: 'zero-width',
      count: index + 1,
      positions: [],
    }));

    const [invisible] = describeCheckCounts({ ...NO_FINDINGS, invisibleChars: { total: 28, kinds } });

    expect(invisible?.detail).toBe('U+2000 ×1、U+2001 ×2、U+2002 ×3、U+2003 ×4、U+2004 ×5、ほか 2 種類');
  });

  it('does not break on a count that is not a number', () => {
    const [invisible] = describeCheckCounts({
      ...NO_FINDINGS,
      invisibleChars: { total: Number.NaN, kinds: [] },
    });

    expect(invisible?.count).toBe(0);
  });
});

describe('the sentences about the state of the check', () => {
  it('states the number of issues and when they were checked for a good check', () => {
    const message = externalStateMessage(makeExternalList());

    expect(message).toMatch(/に確かめました。届いた issue は 1 件です。$/);
  });

  it('keeps the error detail out of the sentence (the caller decides whether to show it)', () => {
    const list = makeExternalList({ state: 'error', error: { kind: 'failed', detail: 'SECRET stderr text' } });

    expect(externalStateMessage(list)).not.toContain('SECRET');
  });

  it('only tells a budget-exhausted failure from a plain one by the start of the detail', () => {
    const budget = makeExternalList({ state: 'error', error: { kind: 'failed', detail: `${BUDGET_EXHAUSTED_DETAIL_PREFIX}: at most 12` } });
    const plain = makeExternalList({ state: 'error', error: { kind: 'failed', detail: 'timed out' } });
    // 別の種類の detail が偶然同じ書き出しでも、その種類の文のまま。
    const other = makeExternalList({ state: 'error', error: { kind: 'gh-missing', detail: BUDGET_EXHAUSTED_DETAIL_PREFIX } });

    expect(externalStateMessage(budget)).toBe('GitHub への問い合わせの手元の上限に達しました。しばらくしてから確かめられます。');
    expect(externalStateMessage(plain)).toBe('確認に失敗しました。しばらくしてから自動でやり直します。');
    expect(externalStateMessage(other)).toContain('が見つかりません');
  });

  it('says when the shown list is from only while the check is stopped', () => {
    expect(externalStaleNote(makeExternalList())).toBeNull();
    expect(externalStaleNote(makeExternalList({ state: 'error', fetchedAt: null, error: null }))).toBeNull();
    expect(externalStaleNote(makeExternalList({ state: 'error', error: null }))).toMatch(/^最後に確かめられたのは .+ です/);
  });
});

describe('refreshFailureMessage', () => {
  it('puts the Retry-After seconds into the sentence for a 429', () => {
    const error = new ApiError(429, 'x', { body: JSON.stringify({ retryAfterSeconds: 7 }) });

    expect(refreshFailureMessage(error)).toBe('確認は 1 分に 1 回までです。7 秒ほど待ってからもう一度押してください。');
  });

  it.each([new ApiError(429, 'x'), new ApiError(429, 'x', { body: '{"retryAfterSeconds":"7"}' })])(
    'says "later" without a number when a 429 has no usable seconds',
    (error) => {
      expect(refreshFailureMessage(error)).toBe('確認は 1 分に 1 回までです。しばらくしてからもう一度押してください。');
    },
  );

  it.each([new ApiError(403, 'local access only'), new ApiError(500, 'ENOENT /secret'), new Error('network down'), 'text'])(
    'uses one fixed sentence for every other failure',
    (error) => {
      expect(refreshFailureMessage(error)).toBe('今すぐ確認できませんでした。しばらくしてからもう一度押してください。');
    },
  );
});
