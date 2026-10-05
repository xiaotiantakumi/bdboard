/**
 * 変更前の実装 (PR #914 時点) の写し。bdboard-4367 の差分ファズ用。
 * 本体を直したときはこの写しを直さない (写しは固定の基準)。
 */
import { describe, expect, it } from 'vitest';
import { countLinks, type LinkCheck } from './external-issue-links.js';

class ReferenceRangeList {
  private buffer = new Int32Array(16);
  private used = 0;
  get count(): number { return this.used / 2; }
  lastEnd(): number { return this.used === 0 ? -1 : (this.buffer[this.used - 1] ?? -1); }
  popStart(): number { this.used -= 2; return this.buffer[this.used] ?? 0; }
  push(start: number, end: number): void {
    if (this.used + 2 > this.buffer.length) {
      const grown = new Int32Array(this.buffer.length * 2);
      grown.set(this.buffer);
      this.buffer = grown;
    }
    this.buffer[this.used] = start;
    this.buffer[this.used + 1] = end;
    this.used += 2;
  }
  covers(position: number): boolean {
    let low = 0;
    let high = this.used / 2 - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      const start = this.buffer[2 * mid];
      const end = this.buffer[2 * mid + 1];
      if (start === undefined || end === undefined) return false;
      if (position < start) high = mid - 1;
      else if (position >= end) low = mid + 1;
      else return true;
    }
    return false;
  }
}

const REF_BACKSLASH = 0x5c;
const REF_OPEN_BRACKET = 0x5b;
const REF_CLOSE_BRACKET = 0x5d;
const REF_OPEN_PAREN = 0x28;
const REF_CLOSE_PAREN = 0x29;
const REF_NEWLINE = 0x0a;
const REF_BACKTICK = 0x60;
const REF_AUTOLINK = /<[A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*>/g;
const REF_DEFINITION = /^ {0,3}\[(?!\^)[^\]\n]{1,999}\]:[ \t]*\S+/gm;
const REF_RAW_URL = /(?<![A-Za-z0-9])(?:https?:\/\/|www\.)[^\s<>]+/gi;

function referenceFindInlineLinks(text: string): { readonly count: number; readonly covered: ReferenceRangeList } {
  const covered = new ReferenceRangeList();
  let count = 0;
  const open: number[] = [];
  let stop = -1;
  const stopAtOrAfter = (from: number): number => {
    if (stop >= from) return stop;
    let index = from;
    while (index < text.length) {
      const code = text.charCodeAt(index);
      if (code === REF_CLOSE_PAREN || code === REF_NEWLINE) break;
      index += 1;
    }
    stop = index;
    return index;
  };
  let lastBreak = -1;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code === REF_BACKSLASH) {
      index += 1;
      if (text.charCodeAt(index) === REF_NEWLINE) lastBreak = index;
    } else if (code === REF_NEWLINE || code === REF_BACKTICK) {
      lastBreak = index;
    } else if (code === REF_OPEN_BRACKET) {
      open.push(index);
    } else if (code === REF_CLOSE_BRACKET) {
      const start = open.pop();
      if (start === undefined || text.charCodeAt(index + 1) !== REF_OPEN_PAREN) continue;
      const end = stopAtOrAfter(index + 2);
      if (end >= text.length || text.charCodeAt(end) !== REF_CLOSE_PAREN) continue;
      let rangeStart = lastBreak > start ? index : start;
      while (covered.lastEnd() > rangeStart) rangeStart = Math.min(rangeStart, covered.popStart());
      covered.push(rangeStart, end + 1);
      count += 1;
      index = end;
    }
  }
  return { count, covered };
}

function referenceIsCoveredByAny(lists: readonly ReferenceRangeList[], position: number): boolean {
  for (const ranges of lists) if (ranges.covers(position)) return true;
  return false;
}

function referenceMatchesOutside(text: string, pattern: RegExp, covered: readonly ReferenceRangeList[]): ReferenceRangeList {
  const kept = new ReferenceRangeList();
  for (const match of text.matchAll(pattern)) {
    if (referenceIsCoveredByAny(covered, match.index)) continue;
    kept.push(match.index, match.index + match[0].length);
  }
  return kept;
}

function referenceCountLinks(text: string): LinkCheck {
  const inline = referenceFindInlineLinks(text);
  const definitions = referenceMatchesOutside(text, REF_DEFINITION, [inline.covered]);
  const autolinks = referenceMatchesOutside(text, REF_AUTOLINK, [inline.covered, definitions]);
  const rawUrls = referenceMatchesOutside(text, REF_RAW_URL, [inline.covered, definitions, autolinks]);
  return {
    total: inline.count + autolinks.count + definitions.count + rawUrls.count,
    markdownLinks: inline.count,
    autolinks: autolinks.count,
    referenceDefinitions: definitions.count,
    rawUrls: rawUrls.count,
  };
}

function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

const TOKENS = [
  '[', ']', '(', ')', '\n', '\r', '`', '\\', '<', '>', ' ', '\t', 'a', 'b', 'x', '!', ':', '^',
  'https://x.example', 'http://', 'HTTPS://', 'HtTp://y', 'www.', 'www.z', '_https://a', '*www.b',
  'ahttps://', '1www.', '<ab:x>', '<ab:', '<a@b>', '<ab:x y>', '[x]: https://a.example', '[x]:',
  '[^1]: n', '   [d]: e', '    [d]: e', '](u)', '[t](', '![i](j)', '[![i](j)](k)',
  '\u00a0', '\u2028', '\ufeff', '\u3000', '\u200b', String.fromCodePoint(0x1f600), '\ud83d',
];

const FIXED = [
  '[docs](https://docs.example) www.example <ftp://x>',
  '![image](https://img.example) and https://raw.example',
  '[![img](a)](https://outer.example) www.z',
  '[x]: <https://a.example>\n<https://b.example>',
  '[label]: https://a.example and www.b.example',
  'before [open https://hidden.example\n](dest) https://visible.example',
  '[outer [inner](u)](v) <ab:x>',
  '<https://x.example> https://x.example www.x.example',
  '[^1]: https://not-definition.example\n   [d]: e',
  '    [d]: e\n[d]: https://yes.example',
  '`[x](y)` https://raw.example',
  '[x](https://a.example) [y](https://b.example)',
  '[x]: https://a.example\n[x](dest)\n<mailto:a@b>',
  '[text][label] [label]: /dest',
  'https://www.example www.example',
  '[broken](url\nhttps://seen.example',
  '](u) [t]( www.example)',
  '<ab:x y> <a@b> <ab:x>',
  '[https://a.example](x) https://b.example',
  'ahttps://no.example _https://yes.example *www.yes.example',
];

/** 種類ごとに、その種類を数える (または生の URL が覆われる) 入力が最低これだけ要る。4500 件のうち実測は 695 件 (参照定義) 〜 3924 件。 */
const MIN_INPUTS_PER_KIND = 300;

describe('countLinks differential fuzz (PR #914 reference)', () => {
  it('matches the fixed reference on hand-written and seeded token inputs', () => {
    const random = mulberry32(0x4367);
    const inputs = [...FIXED];
    for (let caseIndex = 0; caseIndex < 4500; caseIndex += 1) {
      const length = Math.floor(random() * 61);
      let input = '';
      for (let tokenIndex = 0; tokenIndex < length; tokenIndex += 1) {
        input += TOKENS[Math.floor(random() * TOKENS.length)] ?? '';
      }
      inputs.push(input);
    }
    const seen = { markdownLinks: 0, autolinks: 0, referenceDefinitions: 0, rawUrls: 0, rawUrlsCovered: 0 };
    for (const input of inputs) {
      const actual = countLinks(input);
      expect(actual, `input=${JSON.stringify(input)}`).toEqual(referenceCountLinks(input));
      if (actual.markdownLinks > 0) seen.markdownLinks += 1;
      if (actual.autolinks > 0) seen.autolinks += 1;
      if (actual.referenceDefinitions > 0) seen.referenceDefinitions += 1;
      if (actual.rawUrls > 0) seen.rawUrls += 1;
      // 生の URL が前の種類の範囲に覆われて数えられなかった入力 (覆い判定の分岐を通る入力)。
      if (actual.rawUrls < [...input.matchAll(REF_RAW_URL)].length) seen.rawUrlsCovered += 1;
    }
    // 生成が偏って、ほとんどの入力で何も数えない・覆いが起きないのでは、差分を見る意味が無い。
    for (const [kind, count] of Object.entries(seen)) expect(count, `inputs that exercise ${kind}`).toBeGreaterThan(MIN_INPUTS_PER_KIND);
  });

  it('matches the reference on large mixed inputs', () => {
    const interleaved = Array.from({ length: 2000 }, (_, index) =>
      index % 2 === 0 ? `https://raw${index}.example` : `[x${index}](dest${index})`,
    ).join(' ');
    const cases = [interleaved, `[\n${'https://a.example\n'.repeat(3000)}](x)`];
    for (const input of cases) {
      expect(countLinks(input), `large input length=${input.length}`).toEqual(referenceCountLinks(input));
    }
  });

  it('does not leak the shared raw URL regexp lastIndex between calls', () => {
    const input = '[x](https://inside.example) https://outside.example';
    const expected = referenceCountLinks(input);
    expect(countLinks(input)).toEqual(expected);
    countLinks('www.interleaved.example <https://other.example>');
    expect(countLinks(input)).toEqual(expected);
  });
});
