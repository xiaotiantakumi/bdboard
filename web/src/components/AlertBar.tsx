import {
  computeStatusLevel,
  contactAgeMinutes,
  shouldShowAlertBar,
  STATUS_LABELS,
} from '../boardFreshness';
import { useNow } from '../hooks/useNow';
import type { StreamState } from '../useBoardStream';

export interface AlertBarProps {
  streamState: StreamState;
  lastContactAtMs: number | null | undefined;
  connectStalled?: boolean;
  onRefresh: () => void;
  isRefreshing: boolean;
  onOpenDetails: () => void;
}

const STALL_STATUS_LABEL = '接続待ち';

export function AlertBar({
  streamState,
  lastContactAtMs,
  connectStalled = false,
  onRefresh,
  isRefreshing,
  onOpenDetails,
}: AlertBarProps) {
  const nowMs = useNow();
  const level = computeStatusLevel(streamState, lastContactAtMs, nowMs);

  if (!shouldShowAlertBar(level) && !connectStalled) {
    return null;
  }

  // Banner priority when multiple signals are active at once:
  // error (disconnected) > connectStalled > reconnecting > delayed.
  // connectStalled is independent of StreamState so it can coexist with
  // 'connecting' while grace-based 'reconnecting' only follows onerror.
  const showDisconnected = level === 'disconnected';
  const showStalled = !showDisconnected && connectStalled;
  const showReconnecting = !showDisconnected && !showStalled && level === 'reconnecting';

  const staleMinutes =
    lastContactAtMs !== null && lastContactAtMs !== undefined
      ? contactAgeMinutes(lastContactAtMs, nowMs)
      : null;

  const message = showDisconnected
    ? '盤面データの接続が切断されています'
    : showStalled
      ? 'サーバーに接続できていません。このボードを多数のタブで開いていると、ブラウザの同時接続数の上限で接続待ちになることがあります。不要なタブを閉じてから再接続してください。'
      : showReconnecting
        ? 'サーバーと再接続しています…'
        : staleMinutes !== null
          ? `サーバーと約${staleMinutes}分前から通信できていません`
          : 'サーバーとの通信が遅延しています';

  const detailLabelText = showStalled ? STALL_STATUS_LABEL : STATUS_LABELS[level];

  const isQuiet = showReconnecting || showStalled;

  return (
    <div
      className={isQuiet ? 'alert-bar alert-bar-quiet' : 'alert-bar'}
      role="status"
    >
      <span className="alert-bar-message">{message}</span>
      <div className="alert-bar-actions">
        <button
          type="button"
          className="btn btn-small"
          onClick={onRefresh}
          disabled={isRefreshing}
        >
          {isRefreshing ? '更新中…' : '再接続'}
        </button>
        <button type="button" className="btn btn-small" onClick={onOpenDetails}>
          詳細（{detailLabelText}）
        </button>
      </div>
    </div>
  );
}
