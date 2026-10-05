import { describe, expect, it } from 'vitest';
import {
  ISSUE_DRAFT_ERROR_TEXT_EDGE_CHARS,
  ISSUE_DRAFT_ERROR_TEXT_RAW_MAX_CHARS,
  ISSUE_DRAFT_FREE_TEXT_MAX_CHARS,
  capErrorTextRaw,
  capFreeText,
  summarizeErrorText,
  type IssueDraft,
} from './issue-draft.js';
import { CUT_LINE_BACKOFF_MAX_CHARS, cutKeepingHead, cutKeepingTail } from './issue-draft-cut.js';
import { draftJsonBytes, fitDraftToByteLimit } from './issue-draft-size.js';

// bdboard-4y8q.13: 保存側の切り詰めは行の境目で切り、サロゲートの対を割らない。値はすべて偽の形。
const EMOJI = String.fromCodePoint(0x1f600); // サロゲートの対 (2 コード単位)

function hasLoneSurrogate(value: string): boolean {
  return /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value);
}

/** 決まった種から作る疑似乱数 (mulberry32)。失敗を再現できるように。 */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

describe('cutKeepingHead', () => {
  it('returns a text within the cap unchanged', () => {
    expect(cutKeepingHead('abc\ndef', 7)).toBe('abc\ndef');
  });

  it('cuts back to just after the last newline inside the cap, dropping the incomplete last line', () => {
    expect(cutKeepingHead('line one\nline two\nline three', 22)).toBe('line one\nline two\n');
  });

  it('keeps everything up to the cap when the next character is the newline (the last line is complete)', () => {
    expect(cutKeepingHead('line one\nline two\nmore', 17)).toBe('line one\nline two');
  });

  it('treats a carriage return as a line break too', () => {
    expect(cutKeepingHead('line one\r\nline two', 13)).toBe('line one\r\n');
  });

  it('cuts at the cap when there is no newline (a one-line field)', () => {
    expect(cutKeepingHead('x'.repeat(50), 20)).toBe('x'.repeat(20));
  });

  it('does not go back further than CUT_LINE_BACKOFF_MAX_CHARS for a newline', () => {
    const text = `head\n${'y'.repeat(CUT_LINE_BACKOFF_MAX_CHARS + 100)}`;
    const cap = 5 + CUT_LINE_BACKOFF_MAX_CHARS + 10;
    expect(cutKeepingHead(text, cap)).toBe(text.slice(0, cap));
    // 改行がちょうど戻れる範囲の端にあれば戻る。
    const near = `${'z'.repeat(10)}\n${'y'.repeat(CUT_LINE_BACKOFF_MAX_CHARS + 100)}`;
    expect(cutKeepingHead(near, 10 + CUT_LINE_BACKOFF_MAX_CHARS)).toBe(`${'z'.repeat(10)}\n`);
    expect(cutKeepingHead(near, 11 + CUT_LINE_BACKOFF_MAX_CHARS)).toBe(near.slice(0, 11 + CUT_LINE_BACKOFF_MAX_CHARS));
  });

  it('never splits a surrogate pair at the cut', () => {
    const text = `${'a'.repeat(9)}${EMOJI}b`;
    expect(cutKeepingHead(text, 10)).toBe('a'.repeat(9));
    expect(cutKeepingHead(text, 11)).toBe(`${'a'.repeat(9)}${EMOJI}`);
  });

  it('holds its guarantees for random texts and caps', () => {
    const next = random(13);
    const alphabet = ['a', 'b', ' ', '\n', EMOJI, 'あ', '\r'];
    for (let round = 0; round < 500; round += 1) {
      let text = '';
      const length = Math.floor(next() * 200);
      for (let index = 0; index < length; index += 1) text += alphabet[Math.floor(next() * alphabet.length)] ?? 'a';
      const cap = Math.floor(next() * (text.length + 5));
      const cut = cutKeepingHead(text, cap);
      expect(cut.length).toBeLessThanOrEqual(Math.max(cap, 0));
      expect(text.startsWith(cut)).toBe(true);
      expect(hasLoneSurrogate(cut)).toBe(false);
      if (cut !== text && /[\r\n]/.test(text.slice(0, cap))) {
        // 戻れる範囲 (この長さでは全部) に改行があれば、残した側は行の終わりで終わる。
        expect(/[\r\n]$/.test(cut) || /^[\r\n]/.test(text.slice(cut.length))).toBe(true);
      }
    }
  });
});

describe('cutKeepingTail (tail-capture)', () => {
  it('returns a text within the cap unchanged', () => {
    expect(cutKeepingTail('abc\ndef', 7)).toBe('abc\ndef');
  });

  it('drops the first incomplete line', () => {
    // 末尾 22 文字は "ne\nline two\nline three"。最初の "ne" が不完全な行。
    expect(cutKeepingTail('line one\nline two\nline three', 22)).toBe('line two\nline three');
  });

  it('keeps the first line when the cut lands just after a newline (the line is complete)', () => {
    expect(cutKeepingTail('line one\nline two', 8)).toBe('line two');
    // 残す側にまだ改行があっても、最初の行は完全なので捨てない (次の改行まで進まない)。
    expect(cutKeepingTail('line one\nline two\nline three', 19)).toBe('line two\nline three');
  });

  it('drops CRLF as one line break', () => {
    expect(cutKeepingTail('line one\r\nline two', 12)).toBe('line two');
    // 切れ目が CR と LF の間に落ちても、残す側を LF で始めない。
    expect(cutKeepingTail('aaa\r\nbbb', 4)).toBe('bbb');
  });

  it('treats the line separators of the public body normalization as line breaks too', () => {
    expect(cutKeepingTail('line one\u2029line two', 12)).toBe('line two');
    expect(cutKeepingHead('line one\u2028line two', 12)).toBe('line one\u2028');
    expect(cutKeepingHead('line one\u0085line two', 12)).toBe('line one\u0085');
  });

  it('cuts at the cap when there is no newline (a one-line field)', () => {
    expect(cutKeepingTail('x'.repeat(50), 20)).toBe('x'.repeat(20));
  });

  it('does not go forward further than CUT_LINE_BACKOFF_MAX_CHARS for a newline', () => {
    const text = `${'y'.repeat(CUT_LINE_BACKOFF_MAX_CHARS + 100)}\ntail`;
    const cap = CUT_LINE_BACKOFF_MAX_CHARS + 20;
    expect(cutKeepingTail(text, cap)).toBe(text.slice(text.length - cap));
    expect(cutKeepingTail(text, CUT_LINE_BACKOFF_MAX_CHARS + 4)).toBe('tail');
  });

  it('never splits a surrogate pair at the cut', () => {
    const text = `b${EMOJI}${'a'.repeat(9)}`;
    expect(cutKeepingTail(text, 10)).toBe('a'.repeat(9));
    expect(cutKeepingTail(text, 11)).toBe(`${EMOJI}${'a'.repeat(9)}`);
  });

  it('holds its guarantees for random texts and caps', () => {
    const next = random(29);
    const alphabet = ['a', 'b', ' ', '\n', EMOJI, 'あ', '\r'];
    for (let round = 0; round < 500; round += 1) {
      let text = '';
      const length = Math.floor(next() * 200);
      for (let index = 0; index < length; index += 1) text += alphabet[Math.floor(next() * alphabet.length)] ?? 'a';
      const cap = Math.floor(next() * (text.length + 5));
      const cut = cutKeepingTail(text, cap);
      expect(cut.length).toBeLessThanOrEqual(Math.max(cap, 0));
      expect(text.endsWith(cut)).toBe(true);
      expect(hasLoneSurrogate(cut)).toBe(false);
      if (cut !== text && /[\r\n]/.test(text.slice(text.length - cap))) {
        expect(/[\r\n]$/.test(text.slice(0, text.length - cut.length))).toBe(true);
      }
    }
  });
});

describe('the storage caps cut at a line end and never leave half a surrogate pair', () => {
  it('capErrorTextRaw cuts back to a line end', () => {
    const line = '    at fn (/work/example-project/src/a.ts:1:1)\n';
    const text = line.repeat(Math.ceil(ISSUE_DRAFT_ERROR_TEXT_RAW_MAX_CHARS / line.length) + 5);
    const capped = capErrorTextRaw(text);
    expect(capped.length).toBeLessThanOrEqual(ISSUE_DRAFT_ERROR_TEXT_RAW_MAX_CHARS);
    expect(capped.endsWith('\n')).toBe(true);
    expect(capped.endsWith(line)).toBe(true);
  });

  it('capFreeText cuts back to a line end', () => {
    const text = `${'s'.repeat(7990)}\n${'t'.repeat(100)}`;
    expect(capFreeText(text)).toBe(`${'s'.repeat(7990)}\n`);
  });

  it.each([
    ['capErrorTextRaw', capErrorTextRaw, ISSUE_DRAFT_ERROR_TEXT_RAW_MAX_CHARS],
    ['capFreeText', capFreeText, ISSUE_DRAFT_FREE_TEXT_MAX_CHARS],
  ] as const)('%s does not split a surrogate pair at its cap', (_name, cap, max) => {
    const capped = cap(`${'a'.repeat(max - 1)}${EMOJI}b`);
    expect(capped).toBe('a'.repeat(max - 1));
    expect(hasLoneSurrogate(capped)).toBe(false);
  });

  it('summarizeErrorText cuts the head at a line end and the tail at a line start, without splitting a pair', () => {
    const edge = ISSUE_DRAFT_ERROR_TEXT_EDGE_CHARS;
    const text = `${'h'.repeat(edge - 5)}\nHEAD-REST${'m'.repeat(5000)}TAIL-START\n${'t'.repeat(edge - 5)}`;
    const summary = summarizeErrorText(text);
    expect(summary.truncated).toBe(true);
    expect(summary.head).toBe(`${'h'.repeat(edge - 5)}\n`);
    expect(summary.tail).toBe('t'.repeat(edge - 5));
    expect(summary.omittedChars).toBe(text.length - summary.head.length - summary.tail.length);

    const pairs = `${'a'.repeat(edge - 1)}${EMOJI}${'m'.repeat(3000)}${EMOJI}${'z'.repeat(edge - 1)}`;
    const split = summarizeErrorText(pairs);
    expect(split.head).toBe('a'.repeat(edge - 1));
    expect(split.tail).toBe('z'.repeat(edge - 1));
    expect(hasLoneSurrogate(split.head) || hasLoneSurrogate(split.tail)).toBe(false);
  });

  function draftWith(localOnly: Partial<IssueDraft['localOnly']>): IssueDraft {
    return {
      id: '1758812345678-a1b2c3d4e5f6a7b8',
      kind: 'B',
      fingerprint: 'B:example-hook:0123456789abcdef',
      title: 'title',
      body: 'body',
      titleEditedByUser: false,
      bodyEditedByUser: false,
      localOnly: {
        symptomRaw: '',
        causeRaw: '',
        preventionRaw: '',
        errorTextTruncated: false,
        envInfo: { bdboardVersion: '0.0.0', os: 'darwin', nodeVersion: 'v22.14.0' },
        ...localOnly,
      },
      occurredProjects: [],
      occurrenceCount: 1,
      firstOccurredAt: '2026-10-04T12:00:00.000Z',
      lastOccurredAt: '2026-10-04T12:00:00.000Z',
      status: 'pending',
      draftSchemaVersion: 1,
    };
  }

  it('fitDraftToByteLimit shrinks a field without leaving half a surrogate pair, and stays within the cap', () => {
    const emojiOnly = EMOJI.repeat(30_000); // 4 バイト x 30000、改行なし
    for (const max of [100_000, 100_001, 100_002, 99_999, 90_001, 80_003]) {
      const fitted = fitDraftToByteLimit(draftWith({ errorTextRaw: emojiOnly }), max);
      const raw = fitted.localOnly.errorTextRaw ?? '';
      expect(draftJsonBytes(fitted)).toBeLessThanOrEqual(max);
      expect(raw.length).toBeGreaterThan(0);
      expect(hasLoneSurrogate(raw)).toBe(false);
    }
  });

  it('fitDraftToByteLimit cuts a multi-line field back to a line end', () => {
    const lines = `${'l'.repeat(70)}\n`.repeat(1500);
    const draft = draftWith({ errorTextRaw: lines });
    const fitted = fitDraftToByteLimit(draft, draftJsonBytes(draft) - 1000);
    const raw = fitted.localOnly.errorTextRaw ?? '';
    expect(raw.endsWith('\n')).toBe(true);
    expect(raw.length).toBeLessThan(lines.length);
    expect(lines.startsWith(raw)).toBe(true);
  });
});
