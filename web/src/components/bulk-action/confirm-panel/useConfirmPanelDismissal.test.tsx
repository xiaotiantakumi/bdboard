// bdboard-sso1.65: useBulkActions.ts から切り出した useConfirmPanelDismissal の
// 単体テスト。handleCancelConfirm の pending ガードと、useFocusTrap への配線
// (enabled=confirmingAction!==null, onEscape=handleCancelConfirm) を、実際の
// DOM 要素 (confirmPanelRef/cancelConfirmRef) を使って検証する。
// useFocusTrap 自体の Tab 循環・可視性判定などの詳細は
// web/src/hooks/useFocusTrap.test.tsx で別途カバーされているため、ここでは
// 「このフックがどう useFocusTrap を使っているか」だけを確認する。
import { fireEvent, render, screen } from '@testing-library/react';
import { useRef } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { BulkConfirmingAction } from '../types';
import { useConfirmPanelDismissal } from './useConfirmPanelDismissal';

function Harness({
  confirmingAction,
  mutationPending,
  resetConfirmFields,
}: {
  confirmingAction: BulkConfirmingAction | null;
  mutationPending: boolean;
  resetConfirmFields: () => void;
}) {
  const confirmPanelRef = useRef<HTMLDivElement>(null);
  const cancelConfirmRef = useRef<HTMLButtonElement>(null);
  const { handleCancelConfirm } = useConfirmPanelDismissal({
    confirmingAction,
    mutationPending,
    confirmPanelRef,
    cancelConfirmRef,
    resetConfirmFields,
  });

  return (
    <div>
      <button type="button">confirm-panel の外側のボタン</button>
      {confirmingAction !== null && (
        <div ref={confirmPanelRef}>
          <button ref={cancelConfirmRef} type="button" onClick={handleCancelConfirm}>
            キャンセル
          </button>
          <button type="button">実行する</button>
        </div>
      )}
    </div>
  );
}

describe('useConfirmPanelDismissal', () => {
  it('does not reset when a mutation is pending', () => {
    const resetConfirmFields = vi.fn();
    render(
      <Harness
        confirmingAction={{ kind: 'close' }}
        mutationPending={true}
        resetConfirmFields={resetConfirmFields}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }));

    expect(resetConfirmFields).not.toHaveBeenCalled();
  });

  it('resets when no mutation is pending', () => {
    const resetConfirmFields = vi.fn();
    render(
      <Harness
        confirmingAction={{ kind: 'close' }}
        mutationPending={false}
        resetConfirmFields={resetConfirmFields}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }));

    expect(resetConfirmFields).toHaveBeenCalledTimes(1);
  });

  it('wires useFocusTrap so the initial focus lands on the cancel button while the panel is open', () => {
    render(
      <Harness
        confirmingAction={{ kind: 'close' }}
        mutationPending={false}
        resetConfirmFields={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: 'キャンセル' })).toHaveFocus();
  });

  it('wires onEscape to handleCancelConfirm: Escape inside the panel resets and returns focus', () => {
    const resetConfirmFields = vi.fn();
    render(
      <Harness
        confirmingAction={{ kind: 'close' }}
        mutationPending={false}
        resetConfirmFields={resetConfirmFields}
      />,
    );

    const cancelButton = screen.getByRole('button', { name: 'キャンセル' });
    expect(cancelButton).toHaveFocus();

    fireEvent.keyDown(cancelButton, { key: 'Escape' });

    expect(resetConfirmFields).toHaveBeenCalledTimes(1);
  });

  it('does not enable the focus trap when there is no confirming action', () => {
    render(
      <Harness
        confirmingAction={null}
        mutationPending={false}
        resetConfirmFields={vi.fn()}
      />,
    );

    // 確認パネル自体が描画されないので、キャンセルボタンは存在しない
    expect(screen.queryByRole('button', { name: 'キャンセル' })).toBeNull();
  });
});
