import { describe, expect, it } from 'vitest';
import { chatSettingsSummaryParts, partitionThreadDrawerRows } from './threads';

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

// bdboard-sso1.83 第6段: partitionThreadDrawerRows を移した際に足したテスト。
describe('partitionThreadDrawerRows', () => {
  const thread = (overrides: Partial<import('../../api').ChatThreadDto> & { sessionId: string }) => ({
    agentId: 'claude',
    title: null,
    pinned: false,
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  });

  it('ピン留めされた開いているスレッドを pinnedOpen へ、それ以外を unpinnedOpen へ振り分ける', () => {
    const threadById = new Map([
      ['sess-pinned', thread({ sessionId: 'sess-pinned', pinned: true })],
      ['sess-unpinned', thread({ sessionId: 'sess-unpinned', pinned: false })],
    ]);
    const result = partitionThreadDrawerRows(['sess-pinned', 'sess-unpinned'], [], threadById);
    expect(result.pinnedOpen).toEqual(['sess-pinned']);
    expect(result.unpinnedOpen).toEqual(['sess-unpinned']);
  });

  it('ピン留めされた閉じたスレッドを pinnedClosed へ、それ以外を unpinnedClosed へ振り分ける', () => {
    const closed = [
      thread({ sessionId: 'sess-closed-pinned', pinned: true }),
      thread({ sessionId: 'sess-closed-unpinned', pinned: false }),
    ];
    const result = partitionThreadDrawerRows([], closed, new Map());
    expect(result.pinnedClosed.map((t) => t.sessionId)).toEqual(['sess-closed-pinned']);
    expect(result.unpinnedClosed.map((t) => t.sessionId)).toEqual(['sess-closed-unpinned']);
  });

  it('相対順序を保ったまま振り分ける(filter は順序を変えない)', () => {
    const threadById = new Map([
      ['a', thread({ sessionId: 'a', pinned: false })],
      ['b', thread({ sessionId: 'b', pinned: false })],
      ['c', thread({ sessionId: 'c', pinned: false })],
    ]);
    const result = partitionThreadDrawerRows(['a', 'b', 'c'], [], threadById);
    expect(result.unpinnedOpen).toEqual(['a', 'b', 'c']);
  });

  it('threadById に無いセッションIDは pinned !== true として unpinnedOpen に入る', () => {
    const result = partitionThreadDrawerRows(['sess-unknown'], [], new Map());
    expect(result.pinnedOpen).toEqual([]);
    expect(result.unpinnedOpen).toEqual(['sess-unknown']);
  });
});
