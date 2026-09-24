import { describe, expect, it } from 'vitest';
import { computeSubmitDisabled, joinDescribedBy, type ComputeSubmitDisabledInput } from './composerState';

// bdboard-sso1.83 第7段: ChatPanel.tsx の JSX にインラインで書かれていた送信
// ボタンの disabled 判定式と aria-describedby の結合式を composerState.ts へ
// 移した際に足したテスト。分岐(否定条件)ごとに表形式で確認する。

const BASE: ComputeSubmitDisabledInput = {
  selectedProjectId: 'proj-a',
  isSending: false,
  isHistoryPending: false,
  chatUnsupported: false,
  selectedAgentUnavailable: false,
  hasUnsupportedAttachments: false,
  hasUnresolvedProjectRecovery: false,
  currentInput: 'hello',
  attachmentsCount: 0,
};

describe('computeSubmitDisabled', () => {
  it('全条件が満たされていれば false (送信可能)', () => {
    expect(computeSubmitDisabled(BASE)).toBe(false);
  });

  it.each([
    ['selectedProjectId が空', { selectedProjectId: '' }],
    ['isSending 中', { isSending: true }],
    ['isHistoryPending 中', { isHistoryPending: true }],
    ['chatUnsupported', { chatUnsupported: true }],
    ['selectedAgentUnavailable', { selectedAgentUnavailable: true }],
    ['hasUnsupportedAttachments', { hasUnsupportedAttachments: true }],
    ['hasUnresolvedProjectRecovery (bdboard-v3ag)', { hasUnresolvedProjectRecovery: true }],
  ] as const)('%s のとき true (送信不可)', (_label, override) => {
    expect(computeSubmitDisabled({ ...BASE, ...override })).toBe(true);
  });

  it('本文が空白のみで添付も無いとき true', () => {
    expect(
      computeSubmitDisabled({ ...BASE, currentInput: '   ', attachmentsCount: 0 }),
    ).toBe(true);
  });

  it('本文が空でも添付が1件あれば false', () => {
    expect(
      computeSubmitDisabled({ ...BASE, currentInput: '', attachmentsCount: 1 }),
    ).toBe(false);
  });

  it('本文があれば添付が0件でも false', () => {
    expect(
      computeSubmitDisabled({ ...BASE, currentInput: 'x', attachmentsCount: 0 }),
    ).toBe(false);
  });
});

describe('joinDescribedBy', () => {
  it('null を除いてスペース区切りで結合する', () => {
    expect(joinDescribedBy(['a', null, 'b'])).toBe('a b');
  });

  it('全て null なら undefined を返す(空文字列にしない)', () => {
    expect(joinDescribedBy([null, null])).toBeUndefined();
  });

  it('空配列でも undefined を返す', () => {
    expect(joinDescribedBy([])).toBeUndefined();
  });

  it('1件だけ非 null ならその値をそのまま返す', () => {
    expect(joinDescribedBy([null, 'only-id'])).toBe('only-id');
  });
});
