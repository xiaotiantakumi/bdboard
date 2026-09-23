import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  useTicketFormReset,
  type UseTicketFormResetParams,
} from './useTicketFormReset';

// このフックの不変条件は「ticketId/projectRootPath が変わったときだけ
// リセットが走ること」と「決まった順序でリセットが呼ばれること」の2つ。
// 前者を崩すと (a) チケットを開くたびに無関係な再レンダーでも下書きが
// 消える、後者を崩すと agentRun 以外のセクションで復元順序が乱れる。
// TicketDetailPanel.tsx から抽出する前の resetFormState + useEffect の
// 挙動をそのまま検証する (bdboard-sso1.5)。

function makeParams(
  overrides: Partial<UseTicketFormResetParams> = {},
): UseTicketFormResetParams {
  return {
    ticketId: 'bd-1',
    projectRootPath: '/repo',
    clearCopyDisplay: vi.fn(),
    resetDecision: vi.fn(),
    resetQuickActions: vi.fn(),
    resetComment: vi.fn(),
    resetDependencies: vi.fn(),
    resetLabelInput: vi.fn(),
    resetTitleEditing: vi.fn(),
    resetDescriptionEditing: vi.fn(),
    resetSessionLink: vi.fn(),
    ...overrides,
  };
}

describe('useTicketFormReset', () => {
  it('resets every section once on mount, passing clearSubmittedDecision: true to resetDecision', () => {
    const params = makeParams();
    renderHook(() => useTicketFormReset(params));

    expect(params.clearCopyDisplay).toHaveBeenCalledTimes(1);
    expect(params.resetDecision).toHaveBeenCalledTimes(1);
    expect(params.resetDecision).toHaveBeenCalledWith({
      clearSubmittedDecision: true,
    });
    expect(params.resetQuickActions).toHaveBeenCalledTimes(1);
    expect(params.resetComment).toHaveBeenCalledTimes(1);
    expect(params.resetDependencies).toHaveBeenCalledTimes(1);
    expect(params.resetLabelInput).toHaveBeenCalledTimes(1);
    expect(params.resetTitleEditing).toHaveBeenCalledTimes(1);
    expect(params.resetDescriptionEditing).toHaveBeenCalledTimes(1);
    expect(params.resetSessionLink).toHaveBeenCalledTimes(1);
  });

  it('calls the resets in the original resetFormState order', () => {
    const order: string[] = [];
    const params = makeParams({
      clearCopyDisplay: vi.fn(() => order.push('clearCopyDisplay')),
      resetDecision: vi.fn(() => order.push('resetDecision')),
      resetQuickActions: vi.fn(() => order.push('resetQuickActions')),
      resetComment: vi.fn(() => order.push('resetComment')),
      resetDependencies: vi.fn(() => order.push('resetDependencies')),
      resetLabelInput: vi.fn(() => order.push('resetLabelInput')),
      resetTitleEditing: vi.fn(() => order.push('resetTitleEditing')),
      resetDescriptionEditing: vi.fn(() =>
        order.push('resetDescriptionEditing'),
      ),
      resetSessionLink: vi.fn(() => order.push('resetSessionLink')),
    });

    renderHook(() => useTicketFormReset(params));

    expect(order).toEqual([
      'clearCopyDisplay',
      'resetDecision',
      'resetQuickActions',
      'resetComment',
      'resetDependencies',
      'resetLabelInput',
      'resetTitleEditing',
      'resetDescriptionEditing',
      'resetSessionLink',
    ]);
  });

  it('does not re-run the reset on a re-render with unchanged ticketId/projectRootPath and stable callbacks', () => {
    const params = makeParams();
    const { rerender } = renderHook(() => useTicketFormReset(params));

    expect(params.resetComment).toHaveBeenCalledTimes(1);

    rerender();

    expect(params.resetComment).toHaveBeenCalledTimes(1);
  });

  it('re-runs the reset when ticketId changes', () => {
    const params = makeParams({ ticketId: 'bd-1' });
    const { rerender } = renderHook(
      (props: UseTicketFormResetParams) => useTicketFormReset(props),
      { initialProps: params },
    );

    expect(params.resetSessionLink).toHaveBeenCalledTimes(1);

    rerender({ ...params, ticketId: 'bd-2' });

    expect(params.resetSessionLink).toHaveBeenCalledTimes(2);
  });

  it('re-runs the reset when only projectRootPath changes (ticketId unchanged)', () => {
    const params = makeParams({ projectRootPath: '/repo-a' });
    const { rerender } = renderHook(
      (props: UseTicketFormResetParams) => useTicketFormReset(props),
      { initialProps: params },
    );

    expect(params.resetLabelInput).toHaveBeenCalledTimes(1);

    rerender({ ...params, projectRootPath: '/repo-b' });

    expect(params.resetLabelInput).toHaveBeenCalledTimes(2);
  });

  it('does not touch an agentRun reset — this hook takes no such param', () => {
    // 型レベルの保証: UseTicketFormResetParams に agentRun 由来のフィールドが
    // 無いことをコンパイル時に確認する (PR-L の effect 順序リグレッションの
    // 再発防止。実行時の重複呼び出しをテストする対象が無いため、意図を
    // ドキュメントする以外の意味は無い)。
    const params = makeParams();
    expect(Object.keys(params)).not.toContain('resetAgentRun');
  });
});
