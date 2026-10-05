import { describe, expect, it } from 'vitest';
import { createDraftFromReport } from './issue-draft-build.js';
import { applyDraftEdit } from './issue-draft-edit.js';
import { hasVisibleText } from './issue-draft-identifier.js';
import type { ReceiveDraftInput } from './issue-draft-input.js';
import type { IssueDraft } from './issue-draft.js';

/**
 * bdboard-ov0t: 見えない文字だけの題名・本文の扱いを 1 箇所 (hasVisibleText) に揃える。
 * 題名・本文を編集で「自動の文へ戻す」かの判定は、題名も本文も同じ hasVisibleText。以前は本文だけ trim() で見ていたので、
 * ZWSP や U+2800 だけの本文は「直した」見えない本文として保存されていた (題名は ZWSP だけなら戻っていた)。
 */

// 画面では何も見えない文字だけの値。1 つの文字ごとに 1 行。
const INVISIBLE_ONLY: ReadonlyArray<readonly [string, string]> = [
  ['an empty string', ''],
  ['spaces and a newline', ' \n\t '],
  ['a lone ZERO WIDTH SPACE (U+200B)', '\u200B'],
  ['a lone BRAILLE PATTERN BLANK (U+2800)', '⠀'],
  ['a lone ZERO WIDTH NON-JOINER (U+200C)', '\u200C'],
  ['a lone ZERO WIDTH JOINER (U+200D)', '\u200D'],
  ['a lone WORD JOINER (U+2060)', '\u2060'],
  ['a lone byte order mark (U+FEFF)', '\uFEFF'],
  ['a lone SOFT HYPHEN (U+00AD)', '­'],
  ['a lone LEFT-TO-RIGHT MARK (U+200E)', '\u200E'],
  ['a lone RIGHT-TO-LEFT OVERRIDE (U+202E)', '\u202E'],
  ['a lone HANGUL FILLER (U+3164)', 'ㅤ'],
  ['a lone HALFWIDTH HANGUL FILLER (U+FFA0)', 'ﾠ'],
  ['a lone MONGOLIAN VOWEL SEPARATOR (U+180E)', '᠎'],
  ['a lone tag character (U+E0061)', '\u{E0061}'],
  ['a lone control character (U+0001)', '\u0001'],
  ['a lone combining acute accent (U+0301)', '́'],
  ['a lone VARIATION SELECTOR-16 (U+FE0F)', '️'],
  ['zero-width characters between newlines', '\u200B\n\u200B\n⠀'],
];

describe('hasVisibleText treats every character that draws nothing as invisible (bdboard-ov0t)', () => {
  it.each(INVISIBLE_ONLY)('is false for %s', (_name, value) => {
    expect(hasVisibleText(value)).toBe(false);
  });

  it('stays true as soon as one character is drawn, even next to invisible ones', () => {
    for (const shown of ['a', '\u200Bx\u200B', '⠀⠁', '\u202Eabc', 'é', '👩\u200D💻', '　x', '⠀.']) {
      expect(hasVisibleText(shown)).toBe(true);
    }
  });
});

const input: ReceiveDraftInput = {
  kind: 'B',
  source: 'hook.sh',
  envInfo: { bdboardVersion: '1.0', os: 'darwin', nodeVersion: 'v22' },
  project: { name: 'proj-name', path: '/work/proj-name' },
};

function editedDraft(): IssueDraft {
  const base = createDraftFromReport(input, { id: '1758812345678-a1b2c3d4e5f6a7b8', fingerprint: 'B:hook.sh:abcd', nowIso: '2026-10-04T12:00:00.000Z' });
  return { ...base, title: 'custom title', body: 'custom body', titleEditedByUser: true, bodyEditedByUser: true };
}

describe('applyDraftEdit resets a field that shows nothing, by one rule for the title and the body (bdboard-ov0t)', () => {
  const automatic = applyDraftEdit({ ...editedDraft(), title: '', body: '' }, { title: '', body: '' }).draft;

  it.each(INVISIBLE_ONLY)('resets the body to the automatic text for %s', (_name, value) => {
    const result = applyDraftEdit(editedDraft(), { body: value }).draft;
    expect(result.body).toBe(automatic.body);
    expect(result.bodyEditedByUser).toBe(false);
    expect(result.title).toBe('custom title');
    expect(result.titleEditedByUser).toBe(true);
  });

  it.each(INVISIBLE_ONLY)('resets the title to the automatic text for %s', (_name, value) => {
    const result = applyDraftEdit(editedDraft(), { title: value }).draft;
    expect(result.title).toBe(automatic.title);
    expect(result.titleEditedByUser).toBe(false);
    expect(result.body).toBe('custom body');
    expect(result.bodyEditedByUser).toBe(true);
  });

  it('keeps a body that has something to see, exactly as written, and marks it edited', () => {
    const body = '\u200B⠀line\n\u200B';
    const result = applyDraftEdit({ ...editedDraft(), bodyEditedByUser: false }, { body }).draft;
    expect(result.body).toBe(body);
    expect(result.bodyEditedByUser).toBe(true);
  });

  it('does not touch a field that was not sent', () => {
    const result = applyDraftEdit(editedDraft(), { body: '\u200B' }).draft;
    expect(result.title).toBe('custom title');
    expect(result.titleEditedByUser).toBe(true);
  });
});
