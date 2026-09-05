import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  BDBOARD_HELP_PROMPT_LINES,
  formatBdboardHelpForPrompt,
  parseBdboardHelpSections,
} from './help-content.js';

describe('parseBdboardHelpSections', () => {
  it('loads the shared help source used by the web help panel', () => {
    // 原本の文言をこのテストへ写経しない。写経すると docs/help-content.json を直すたびに
    // 無関係な失敗が出るうえ、原本と二重管理になる（bdboard-p739 で実際に踏んだ）。
    // 代わりに原本を独立に読み直し、全セクションが prompt 行へ流れていることを検査する。
    const sections: readonly { title: string; description: string; id: string }[] = JSON.parse(
      readFileSync(new URL('../../../docs/help-content.json', import.meta.url), 'utf8'),
    );

    // 自己防衛: 読めていない/空を掴んだ場合に、下の forEach が空振りで緑になるのを防ぐ。
    expect(sections.length).toBeGreaterThanOrEqual(20);
    expect(sections.map(({ id }) => id)).toContain('kanban');
    expect(sections.map(({ id }) => id)).toContain('pwa');

    for (const { title, description } of sections) {
      expect(BDBOARD_HELP_PROMPT_LINES).toContain(`- ${title}: ${description}`);
    }
  });

  it('rejects malformed entries and duplicate ids', () => {
    expect(() => parseBdboardHelpSections('[{"id":"only-id"}]')).toThrow(/invalid shape/);
    expect(() =>
      parseBdboardHelpSections(
        JSON.stringify([
          { id: 'same', title: 'One', description: 'First', steps: ['Step'] },
          { id: 'same', title: 'Two', description: 'Second', steps: ['Step'] },
        ]),
      ),
    ).toThrow(/duplicate id: same/);
  });
});

describe('formatBdboardHelpForPrompt', () => {
  it('keeps the prompt concise by including summaries without full steps', () => {
    const lines = formatBdboardHelpForPrompt([
      {
        id: 'sample',
        title: 'Sample',
        description: 'Summary',
        steps: ['A long detailed step that belongs in the help panel'],
      },
    ]);

    expect(lines).toContain('- Sample: Summary');
    expect(lines.join('\n')).not.toContain('A long detailed step');
  });
});
