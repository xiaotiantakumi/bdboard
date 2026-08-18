import helpSections from '../../docs/help-content.json';

export interface HelpSection {
  id: string;
  title: string;
  description: string;
  steps: readonly string[];
}

/**
 * アプリ内ヘルプとチャットの system prompt は docs/help-content.json を共通原本にする。
 * Web 側では原本をそのまま表示用データとして公開する。
 */
export const HELP_SECTIONS: readonly HelpSection[] = helpSections;
