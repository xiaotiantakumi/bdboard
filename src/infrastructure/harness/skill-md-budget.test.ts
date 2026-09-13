import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * ハーネスパック正本の SKILL.md が brushup-protocol.md §7 の予算
 * 「1 規律 25 行以内・SKILL.md 全体 8192 バイト以下」を守っていることを機械で固定する
 * (bdboard-pkr6.21)。
 *
 * SKILL.md はパック注入先のすべてのセッションで常時読まれる。bdboard-pkr6.7 (#292) で
 * 8,167 バイトに骨格化したが、予算が文章の目安でしかなかったため、後続の PR が規律の追記を
 * 重ねて 13,000 バイト超まで戻った (誰も気付かなかった)。
 *
 * 見るのは正本 `harness/packs/bdboard-harness/SKILL.md` だけ。注入コピー
 * `.claude/skills/bdboard-harness/SKILL.md` のバイト一致は injected-pack-is-in-sync.test.ts が
 * 保証している。
 */

const SKILL_MD_PATH = fileURLToPath(
  new URL('../../../harness/packs/bdboard-harness/SKILL.md', import.meta.url),
);

const SKILL_MD_MAX_BYTES = 8192;
const DISCIPLINE_MAX_LINES = 25;
const DISCIPLINE_HEADING_PREFIX = '## 規律';

const FIX_HINT = [
  'Fix it the way references/brushup-protocol.md §7 prescribes:',
  '  - do NOT squeeze the wording to fit (vaguer steps breed non-compliance);',
  "  - move the longest discipline's procedure detail into references/ verbatim, and keep only",
  '    the skeleton in SKILL.md: なぜ (<= 3 lines) / 手順 (numbered, one line each) / 詳細 pointer;',
  '  - keep the step numbers stable — references point at "SKILL.md 規律N 手順M";',
  '  - then copy the pack to .claude/skills/bdboard-harness/ and bump the pack version.',
].join('\n');

interface DisciplineSection {
  readonly heading: string;
  readonly lines: number;
}

// 見出し行から次の `## ` 見出しの直前まで (無ければファイル末尾まで) を 1 節と数える。
// CRLF でも同じ行数になるよう \r\n を \n に寄せる。末尾改行の後ろの空要素は行に数えない。
function disciplineSections(text: string): DisciplineSection[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();

  const headingIndexes = lines.flatMap((line, index) => (line.startsWith('## ') ? [index] : []));
  return headingIndexes.flatMap((start, i) => {
    const heading = lines[start] ?? '';
    if (!heading.startsWith(DISCIPLINE_HEADING_PREFIX)) return [];
    const end = headingIndexes[i + 1] ?? lines.length;
    return [{ heading, lines: end - start }];
  });
}

// 予算内なら空配列、超過なら違反ごとの 1 行説明を返す。
function checkSkillMdBudget(
  text: string,
  maxBytes = SKILL_MD_MAX_BYTES,
  maxLines = DISCIPLINE_MAX_LINES,
): string[] {
  const violations: string[] = [];
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > maxBytes) {
    violations.push(`SKILL.md is ${bytes} bytes (limit ${maxBytes}, over by ${bytes - maxBytes}).`);
  }
  for (const section of disciplineSections(text)) {
    if (section.lines > maxLines) {
      violations.push(
        `"${section.heading}" is ${section.lines} lines (limit ${maxLines}, over by ${section.lines - maxLines}).`,
      );
    }
  }
  return violations;
}

function formatFailure(violations: readonly string[]): string {
  return [...violations, '', FIX_HINT].join('\n');
}

const discipline = (n: number, lineCount: number, eol = '\n'): string =>
  [`## 規律${n}: 見出し`, ...Array.from({ length: lineCount - 1 }, (_, i) => `本文 ${i + 1}`)]
    .map((line) => line + eol)
    .join('');

describe('disciplineSections', () => {
  it('counts from a discipline heading up to the next ## heading', () => {
    const text = `# title\n\n${discipline(1, 4)}${discipline(2, 3)}## references\n\nlist\n`;
    expect(disciplineSections(text)).toEqual([
      { heading: '## 規律1: 見出し', lines: 4 },
      { heading: '## 規律2: 見出し', lines: 3 },
    ]);
  });

  it('counts the last discipline up to the end of the file when no heading follows', () => {
    expect(disciplineSections(discipline(6, 5))).toEqual([{ heading: '## 規律6: 見出し', lines: 5 }]);
    // 末尾改行が無くても最終行を数える
    expect(disciplineSections(discipline(6, 5).trimEnd())).toEqual([
      { heading: '## 規律6: 見出し', lines: 5 },
    ]);
  });

  it('ignores ## sections that are not disciplines and ### sub-headings', () => {
    const text = `## 前提\n${'x\n'.repeat(40)}${discipline(1, 3)}### 小見出し\nbody\n## 機械ガード\n${'y\n'.repeat(40)}`;
    expect(disciplineSections(text)).toEqual([{ heading: '## 規律1: 見出し', lines: 5 }]);
  });

  it('gives the same line counts for CRLF line endings', () => {
    const lf = `${discipline(1, 7)}${discipline(2, 25)}## references\n`;
    const crlf = `${discipline(1, 7, '\r\n')}${discipline(2, 25, '\r\n')}## references\r\n`;
    expect(disciplineSections(crlf)).toEqual(disciplineSections(lf));
  });
});

describe('checkSkillMdBudget', () => {
  it('passes at exactly 8192 bytes and fails at 8193', () => {
    expect(checkSkillMdBudget(`${'a'.repeat(8191)}\n`)).toEqual([]);
    expect(checkSkillMdBudget(`${'a'.repeat(8192)}\n`)).toEqual([
      'SKILL.md is 8193 bytes (limit 8192, over by 1).',
    ]);
  });

  it('counts UTF-8 bytes, not characters (Japanese text is 3 bytes per character)', () => {
    // 'あ' は UTF-8 で 3 バイト: 2730 文字 + 'a\n' = 8192 バイト、2731 文字 + 'a\n' = 8195 バイト
    expect(checkSkillMdBudget(`${'あ'.repeat(2730)}a\n`)).toEqual([]);
    expect(checkSkillMdBudget(`${'あ'.repeat(2731)}a\n`)).toEqual([
      'SKILL.md is 8195 bytes (limit 8192, over by 3).',
    ]);
  });

  it('passes a 25-line discipline and fails a 26-line one', () => {
    expect(checkSkillMdBudget(`${discipline(1, 25)}## references\n`)).toEqual([]);
    expect(checkSkillMdBudget(`${discipline(1, 26)}## references\n`)).toEqual([
      '"## 規律1: 見出し" is 26 lines (limit 25, over by 1).',
    ]);
  });

  it('reports a too-long last discipline at the end of the file', () => {
    expect(checkSkillMdBudget(`${discipline(1, 3)}${discipline(6, 30)}`)).toEqual([
      '"## 規律6: 見出し" is 30 lines (limit 25, over by 5).',
    ]);
  });

  it('reports the byte budget and every too-long discipline together', () => {
    const text = `${discipline(1, 26)}${discipline(2, 3)}${discipline(3, 27)}${'a'.repeat(8192)}\n`;
    expect(checkSkillMdBudget(text)).toEqual([
      expect.stringMatching(/^SKILL\.md is \d+ bytes \(limit 8192, over by \d+\)\.$/),
      '"## 規律1: 見出し" is 26 lines (limit 25, over by 1).',
      expect.stringMatching(/^"## 規律3: 見出し" is \d+ lines/),
    ]);
  });

  it('points at the §7 remedy in the failure message', () => {
    const message = formatFailure(checkSkillMdBudget(discipline(1, 26)));
    expect(message).toContain('brushup-protocol.md §7');
    expect(message).toContain('references/');
    expect(message).toContain('.claude/skills/bdboard-harness/');
  });
});

describe('harness/packs/bdboard-harness/SKILL.md', () => {
  it(`stays within ${SKILL_MD_MAX_BYTES} bytes and ${DISCIPLINE_MAX_LINES} lines per discipline`, () => {
    const text = readFileSync(SKILL_MD_PATH, 'utf8');
    // 規律の見出しが 1 つも取れないなら数え方の前提 (`## 規律N`) が崩れている — 黙って素通りさせない。
    expect(disciplineSections(text).length).toBeGreaterThan(0);
    const violations = checkSkillMdBudget(text);
    // expect.fail なら対処の手がかりが改行付きのまま 1 回だけ表示される。
    if (violations.length > 0) expect.fail(formatFailure(violations));
  });
});
