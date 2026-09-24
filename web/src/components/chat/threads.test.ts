import { afterEach, describe, expect, it } from 'vitest';
import { resetBoardTimeZoneForTests, setBoardTimeZoneOverride } from '../../boardTimeZone';
import {
  chatSettingsSummaryParts,
  compareThreadsNewestFirst,
  formatThreadUpdatedAt,
  partitionThreadDrawerRows,
  summarizeTitle,
} from './threads';

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

describe('summarizeTitle', () => {
  it('前後の空白を取り除き、空文字列もそのまま返す', () => {
    expect(summarizeTitle('  short title  ')).toBe('short title');
    expect(summarizeTitle('   ')).toBe('');
  });

  it('trim 後ちょうど40文字は切り詰めない', () => {
    const title = 'a'.repeat(40);
    expect(summarizeTitle(` ${title} `)).toBe(title);
  });

  it('41文字以上は先頭40文字に省略記号を付ける', () => {
    expect(summarizeTitle('a'.repeat(41))).toBe(`${'a'.repeat(40)}…`);
  });

  it('絵文字を UTF-16 コードユニットではなくコードポイント単位で切り詰める', () => {
    const title = '😀'.repeat(41);
    expect(Array.from(summarizeTitle(title))).toEqual([...Array.from('😀'.repeat(40)), '…']);
  });
});

describe('formatThreadUpdatedAt', () => {
  afterEach(() => resetBoardTimeZoneForTests());

  it('不正な日時は空文字列を返す', () => {
    expect(formatThreadUpdatedAt('not-a-date')).toBe('');
  });

  it('UTC の暦日をゼロ埋めなしの M/D で返す', () => {
    setBoardTimeZoneOverride('UTC');
    expect(formatThreadUpdatedAt('2026-03-05T10:00:00Z')).toBe('3/5');
  });

  it('設定されたタイムゾーンに応じて UTC 日付境界を反映する', () => {
    const iso = '2026-03-05T23:30:00Z';
    setBoardTimeZoneOverride('Pacific/Kiritimati');
    const east = formatThreadUpdatedAt(iso);
    expect(east).toBe('3/6');
    setBoardTimeZoneOverride('Etc/GMT+12');
    const west = formatThreadUpdatedAt(iso);
    expect(west).toBe('3/5');
    expect(east).not.toBe(west);
  });
});

describe('compareThreadsNewestFirst', () => {
  const thread = (overrides: Partial<import('../../api').ChatThreadDto> & { sessionId: string }) => ({
    agentId: 'claude',
    title: null,
    pinned: false,
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  });

  it('新しい updatedAt を先に並べ、比較結果の符号も正しく返す', () => {
    const old = thread({ sessionId: 'old', updatedAt: '2026-01-01T00:00:00Z' });
    const newer = thread({ sessionId: 'new', updatedAt: '2026-01-02T00:00:00Z' });
    expect(compareThreadsNewestFirst(newer, old)).toBeLessThan(0);
    expect(compareThreadsNewestFirst(old, newer)).toBeGreaterThan(0);
    expect([old, newer].sort(compareThreadsNewestFirst)).toEqual([newer, old]);
  });

  it('undefined と不正な updatedAt は recency 0 として扱われる', () => {
    const valid = thread({ sessionId: 'valid', updatedAt: '2026-01-01T00:00:00Z' });
    const invalid = thread({ sessionId: 'invalid', updatedAt: 'not-a-date' });
    // Array.prototype.sort は比較関数の結果によらず実配列要素の undefined を必ず
    // 末尾へ寄せる(ECMA-262 の仕様上の特別扱い)ため、undefined を含む配列の sort 結果を
    // 直接 toEqual で検証すると compareThreadsNewestFirst の挙動ではなく sort の仕様を
    // テストしてしまう。ここでは比較結果を個別に確認する。
    expect(compareThreadsNewestFirst(valid, undefined)).toBeLessThan(0);
    expect(compareThreadsNewestFirst(undefined, valid)).toBeGreaterThan(0);
    expect(compareThreadsNewestFirst(valid, invalid)).toBeLessThan(0);
    expect(compareThreadsNewestFirst(invalid, valid)).toBeGreaterThan(0);
    expect(compareThreadsNewestFirst(undefined, invalid)).toBe(0);
    expect([invalid, valid].sort(compareThreadsNewestFirst).map((t) => t?.sessionId)).toEqual([
      'valid',
      'invalid',
    ]);
  });

  it('同じ updatedAt なら0を返す', () => {
    const a = thread({ sessionId: 'a', updatedAt: '2026-01-01T00:00:00Z' });
    const b = thread({ sessionId: 'b', updatedAt: '2026-01-01T00:00:00Z' });
    expect(compareThreadsNewestFirst(a, b)).toBe(0);
  });
});
