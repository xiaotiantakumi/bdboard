// bdboard-sso1.65: useBulkActions.ts から切り出した useConfirmPanelDismissal の
// 単体テスト。handleCancelConfirm の pending ガードと、useFocusTrap への配線
// (enabled=confirmingAction!==null, onEscape=handleCancelConfirm) を、実際の
// DOM 要素 (confirmPanelRef/cancelConfirmRef) を使って検証する。
// useFocusTrap 自体の Tab 循環・可視性判定などの詳細は
// web/src/hooks/useFocusTrap.test.tsx で別途カバーされているため、ここでは
// 「このフックがどう useFocusTrap を使っているか」だけを確認する。
//
// harness の DOM 順序は意図的に「実行する」ボタンを「キャンセル」ボタンより
// 前に置いている (本物の BulkActionConfirmPanel と同じ並び)。こうしないと
// 「初期フォーカスがキャンセルボタンに当たる」テストが、initialFocusRef の
// 配線が壊れて先頭要素へフォールバックしただけでも green になってしまう
// (レビュー指摘)。同様に、キャンセルボタンには本物と同じ
// disabled={mutationPending} を付け、mutationPending 中は実行するボタン側で
// Escape を発火させて「無効化されたボタンにフォーカスが乗らない」実際の
// 挙動を模す。
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
      <button type="button">外側のトリガー</button>
      {confirmingAction !== null && (
        <div ref={confirmPanelRef}>
          <button type="button" disabled={mutationPending}>
            実行する
          </button>
          <button
            ref={cancelConfirmRef}
            type="button"
            disabled={mutationPending}
            onClick={handleCancelConfirm}
          >
            キャンセル
          </button>
        </div>
      )}
    </div>
  );
}

describe('useConfirmPanelDismissal', () => {
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

  it('enables the focus trap only while a confirming action is present, focusing the cancel button (not the earlier "実行する" button) and restoring focus to the pre-open trigger once it closes', () => {
    const resetConfirmFields = vi.fn();
    const { rerender } = render(
      <Harness
        confirmingAction={null}
        mutationPending={false}
        resetConfirmFields={resetConfirmFields}
      />,
    );

    const trigger = screen.getByRole('button', { name: '外側のトリガー' });
    trigger.focus();
    expect(trigger).toHaveFocus();

    // 確認パネルを開く (親では handleDeferBulkAction 等が setConfirmingAction
    // する経路に相当)。
    rerender(
      <Harness
        confirmingAction={{ kind: 'close' }}
        mutationPending={false}
        resetConfirmFields={resetConfirmFields}
      />,
    );

    // DOM 順序では「実行する」が先だが、initialFocusRef=cancelConfirmRef の
    // 配線により、初期フォーカスは「キャンセル」に乗る。
    expect(screen.getByRole('button', { name: 'キャンセル' })).toHaveFocus();

    // 確認パネルを閉じる (resetConfirmFields が親の state を戻した結果に相当)。
    rerender(
      <Harness
        confirmingAction={null}
        mutationPending={false}
        resetConfirmFields={resetConfirmFields}
      />,
    );

    expect(screen.queryByRole('button', { name: 'キャンセル' })).toBeNull();
    // enabled が false に戻ったことで useFocusTrap のクリーンアップが走り、
    // パネルを開く前にフォーカスしていた要素へ戻る。
    expect(trigger).toHaveFocus();
  });

  it('wires onEscape to handleCancelConfirm: Escape inside the panel calls resetConfirmFields', () => {
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

  it('Escape does not call resetConfirmFields while a mutation is pending', () => {
    const resetConfirmFields = vi.fn();
    render(
      <Harness
        confirmingAction={{ kind: 'close' }}
        mutationPending={true}
        resetConfirmFields={resetConfirmFields}
      />,
    );

    // キャンセルボタンは disabled のためフォーカスが乗らない。Escape の
    // keydown リスナーは confirmPanelRef のコンテナに付くので、コンテナ内の
    // 有効な要素 (実行するボタン) から発火させても onEscape 経由で
    // handleCancelConfirm(pending ガード) に届くことを確認する。
    const executeButton = screen.getByRole('button', { name: '実行する' });
    fireEvent.keyDown(executeButton, { key: 'Escape' });

    expect(resetConfirmFields).not.toHaveBeenCalled();
  });
});
