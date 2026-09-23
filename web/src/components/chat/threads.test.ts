import { describe, expect, it } from 'vitest';
import { chatSettingsSummaryParts } from './threads';

// bdboard-sso1.83 第4段: ChatPanel.tsx の chatSettingsSummaryParts 派生値を
// 移した際に足したテスト。
describe('chatSettingsSummaryParts', () => {
  it('プロジェクト名・エージェント名がどちらも揃っているとき全4要素を返す', () => {
    expect(chatSettingsSummaryParts('my-project', '(無題)', 'gpt')).toEqual([
      'チャット設定',
      'my-project',
      '(無題)',
      'gpt',
    ]);
  });

  it('プロジェクト名が undefined のときはその要素を省く', () => {
    expect(chatSettingsSummaryParts(undefined, '(無題)', 'gpt')).toEqual([
      'チャット設定',
      '(無題)',
      'gpt',
    ]);
  });

  it('エージェント名が undefined のときはその要素を省く', () => {
    expect(chatSettingsSummaryParts('my-project', '(無題)', undefined)).toEqual([
      'チャット設定',
      'my-project',
      '(無題)',
    ]);
  });

  it('プロジェクト名が空文字のときもその要素を省く', () => {
    expect(chatSettingsSummaryParts('', '(無題)', 'gpt')).toEqual([
      'チャット設定',
      '(無題)',
      'gpt',
    ]);
  });
});
