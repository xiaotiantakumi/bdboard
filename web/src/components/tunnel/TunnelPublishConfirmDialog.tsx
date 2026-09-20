// bdboard-sso1.35: TunnelControl.tsx の公開確認ダイアログ(alertdialog)を
// 移動しただけの表示専用コンポーネント。state・mutation・ref は
// useTunnelPublish (親で呼び出し) に残し、値とハンドラを props で受け取る。
// confirmPanelRef 用の useFocusTrap 呼び出しは親に残したまま
// (TunnelControl.tsx のコメント参照)、ref だけをこの子へ渡している。
// JSX・className・aria属性・文言・DOM構造は移動前から変えていない。
import type { RefObject } from 'react';

export interface TunnelPublishConfirmDialogProps {
  confirmPanelRef: RefObject<HTMLDivElement | null>;
  cancelPublishRef: RefObject<HTMLButtonElement | null>;
  startPending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

export function TunnelPublishConfirmDialog({
  confirmPanelRef,
  cancelPublishRef,
  startPending,
  onCancel,
  onConfirm,
}: TunnelPublishConfirmDialogProps) {
  return (
    <div
      ref={confirmPanelRef}
      className="tunnel-confirm-panel"
      role="alertdialog"
      aria-labelledby="tunnel-confirm-title"
      aria-describedby="tunnel-confirm-desc"
    >
      <p id="tunnel-confirm-title" className="tunnel-confirm-title">
        公開の確認
      </p>
      <div id="tunnel-confirm-desc" className="tunnel-confirm-desc">
        <p>
          公開すると、全プロジェクトのチケット内容がインターネットから読める状態になります。
        </p>
        <p>
          公開先には Basic 認証が掛かります。スマホはこの画面で発行する1回限りのQRコードから認証済みセッションを開始します。
        </p>
        <p>
          パスワードを空欄のまま公開した場合は、安全なランダムパスワードが自動生成されます。スマホでは公開後のQRコードから開きます。
        </p>
        <p>「キャンセル」を選べば、何も起きずに元の画面に戻れます。</p>
      </div>
      <div className="tunnel-confirm-actions">
        <button
          ref={cancelPublishRef}
          type="button"
          className="btn tunnel-confirm-cancel"
          onClick={onCancel}
          disabled={startPending}
        >
          キャンセル
        </button>
        <button
          type="button"
          className="btn btn-danger-outline"
          onClick={onConfirm}
          disabled={startPending}
        >
          {startPending ? '送信中…' : '公開する'}
        </button>
      </div>
    </div>
  );
}
