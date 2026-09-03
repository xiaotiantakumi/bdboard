import { describe, expect, it } from 'vitest';
import {
  BDBOARD_HELP_PROMPT_LINES,
  formatBdboardHelpForPrompt,
  parseBdboardHelpSections,
} from './help-content.js';

describe('parseBdboardHelpSections', () => {
  it('loads the shared help source used by the web help panel', () => {
    expect(BDBOARD_HELP_PROMPT_LINES).toContain(
      '- Kanban（看板）: 複数プロジェクトの Beads チケットを、Ready / In Progress / 確認待ち / Blocked / Deferred / Done の流れで俯瞰します。',
    );
    expect(BDBOARD_HELP_PROMPT_LINES).toContain(
      '- PWA / ホーム画面への追加: 対応ブラウザでは bdboard をホーム画面やアプリ一覧へ追加し、独立したウィンドウで開けます。',
    );
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
