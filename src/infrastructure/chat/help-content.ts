import { readFileSync } from 'node:fs';

export interface BdboardHelpSection {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly steps: readonly string[];
}

const HELP_CONTENT_URL = new URL('../../../docs/help-content.json', import.meta.url);

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function parseBdboardHelpSections(raw: string): readonly BdboardHelpSection[] {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('bdboard help content must be a non-empty array');
  }

  const ids = new Set<string>();
  return parsed.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(`bdboard help content entry ${index} must be an object`);
    }

    const { id, title, description, steps } = entry as Record<string, unknown>;
    if (
      !isNonEmptyString(id) ||
      !isNonEmptyString(title) ||
      !isNonEmptyString(description) ||
      !Array.isArray(steps) ||
      steps.length === 0 ||
      !steps.every(isNonEmptyString)
    ) {
      throw new Error(`bdboard help content entry ${index} has an invalid shape`);
    }
    if (ids.has(id)) {
      throw new Error(`bdboard help content contains duplicate id: ${id}`);
    }
    ids.add(id);

    return { id, title, description, steps };
  });
}

export function formatBdboardHelpForPrompt(
  sections: readonly BdboardHelpSection[],
): readonly string[] {
  return [
    'bdboard の機能案内:',
    'ユーザーが「このボードの使い方」「どんな機能があるか」などを尋ねたら、',
    '次の公式ヘルプ概要を根拠に答えてください。記載のない操作を推測で断定しないでください。',
    ...sections.map(({ title, description }) => `- ${title}: ${description}`),
  ];
}

/** Web のヘルプ画面も参照する共通原本を、サーバー起動時に一度だけ読む。 */
export const BDBOARD_HELP_PROMPT_LINES = formatBdboardHelpForPrompt(
  parseBdboardHelpSections(readFileSync(HELP_CONTENT_URL, 'utf8')),
);
