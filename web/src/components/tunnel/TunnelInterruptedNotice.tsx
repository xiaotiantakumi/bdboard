// bdboard-sso1.35: TunnelControl.tsx の「前回中断」通知ブロックを移動しただけの
// 表示専用コンポーネント。state・mutation は親 (useTunnelDismiss) に残し、
// 値とハンドラを props で受け取る。JSX・className・aria属性・文言・DOM構造は
// 移動前から変えていない。
import { formatAbsoluteTime } from '../../formatAbsoluteTime';

export interface TunnelInterruptedNoticeProps {
  interruptedAt: string;
  onDismiss: () => void;
  dismissPending: boolean;
}

export function TunnelInterruptedNotice({
  interruptedAt,
  onDismiss,
  dismissPending,
}: TunnelInterruptedNoticeProps) {
  return (
    <div className="tunnel-interrupted-notice" role="status">
      <p className="tunnel-help">
        前回はトンネルが動作中のままサーバーが停止しました。
      </p>
      <p className="tunnel-help">
        公開していた URL は失効しています（cloudflared の URL
        は毎回変わるため、スマホ側は再読み込みでは復旧しません）。
      </p>
      <p className="tunnel-help">
        もう一度スマホから使うには、下のパスワード欄から公開し直して QR
        を取り直してください。
      </p>
      <p className="tunnel-help">
        停止時刻:{' '}
        <time dateTime={interruptedAt}>{formatAbsoluteTime(interruptedAt)}</time>
      </p>
      <button
        type="button"
        className="btn btn-small"
        onClick={onDismiss}
        disabled={dismissPending}
      >
        閉じる
      </button>
    </div>
  );
}
