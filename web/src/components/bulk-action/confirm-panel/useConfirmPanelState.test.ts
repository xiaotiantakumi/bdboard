// bdboard-sso1.65: useBulkActions.ts から切り出した useConfirmPanelState の
// reducer 各 action を直接検証する。分割前は6個の useState だったが、分割後は
// 単一の useReducer に統合しているため、各セッターが対応するフィールドだけを
// 更新すること、resetConfirmFields が「確認パネルを閉じる/一括クイックアクション
// 成功時」に戻すべき4フィールド (confirmingAction/deferPeriodKind/
// customDeferDate/closeReason) だけを初期値へ戻し、bulkLabelInput/lastOutcome には
// 触れないことを確認する。
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DEFAULT_DEFER_PERIOD } from '../../../deferPeriods';
import { useConfirmPanelState } from './useConfirmPanelState';

describe('useConfirmPanelState', () => {
  it('starts with the same initial values as the pre-split useState calls', () => {
    const { result } = renderHook(() => useConfirmPanelState());

    expect(result.current.confirmingAction).toBeNull();
    expect(result.current.deferPeriodKind).toBe(DEFAULT_DEFER_PERIOD);
    expect(result.current.customDeferDate).toBe('');
    expect(result.current.closeReason).toBe('');
    expect(result.current.bulkLabelInput).toBe('');
    expect(result.current.lastOutcome).toBeNull();
  });

  it('each setter updates only its own field', () => {
    const { result } = renderHook(() => useConfirmPanelState());

    act(() => {
      result.current.setConfirmingAction({ kind: 'priority-up' });
    });
    expect(result.current.confirmingAction).toEqual({ kind: 'priority-up' });

    act(() => {
      result.current.setDeferPeriodKind('tomorrow');
    });
    expect(result.current.deferPeriodKind).toBe('tomorrow');
    // 他のフィールドは巻き込まれない
    expect(result.current.confirmingAction).toEqual({ kind: 'priority-up' });

    act(() => {
      result.current.setCustomDeferDate('2026-12-31');
    });
    expect(result.current.customDeferDate).toBe('2026-12-31');

    act(() => {
      result.current.setCloseReason('検証用の理由');
    });
    expect(result.current.closeReason).toBe('検証用の理由');

    act(() => {
      result.current.setBulkLabelInput('urgent');
    });
    expect(result.current.bulkLabelInput).toBe('urgent');

    act(() => {
      result.current.setLastOutcome({ succeeded: [], failed: [] });
    });
    expect(result.current.lastOutcome).toEqual({ succeeded: [], failed: [] });
  });

  it('resetConfirmFields resets confirmingAction/deferPeriodKind/customDeferDate/closeReason but leaves bulkLabelInput and lastOutcome untouched', () => {
    const { result } = renderHook(() => useConfirmPanelState());

    act(() => {
      result.current.setConfirmingAction({ kind: 'defer', untilDate: '2026-10-01' });
      result.current.setDeferPeriodKind('custom');
      result.current.setCustomDeferDate('2026-10-01');
      result.current.setCloseReason('reason');
      result.current.setBulkLabelInput('kept-label');
      result.current.setLastOutcome({ succeeded: ['a'], failed: [] });
    });

    act(() => {
      result.current.resetConfirmFields();
    });

    expect(result.current.confirmingAction).toBeNull();
    expect(result.current.deferPeriodKind).toBe(DEFAULT_DEFER_PERIOD);
    expect(result.current.customDeferDate).toBe('');
    expect(result.current.closeReason).toBe('');
    // bulkLabelInput/lastOutcome はこの reducer action では戻らない
    // (一括ラベル付与の成功時は setBulkLabelInput('') を個別に呼ぶ)。
    expect(result.current.bulkLabelInput).toBe('kept-label');
    expect(result.current.lastOutcome).toEqual({ succeeded: ['a'], failed: [] });
  });

  it('exposes stable ref objects for the confirm panel container and cancel button', () => {
    const { result } = renderHook(() => useConfirmPanelState());

    expect(result.current.confirmPanelRef.current).toBeNull();
    expect(result.current.cancelConfirmRef.current).toBeNull();
  });
});
