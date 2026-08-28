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
  onRefresh: () => void;
  isRefreshing: boolean;
  onOpenDetails: () => void;
}

export function AlertBar({
  streamState,
  lastContactAtMs,
  onRefresh,
  isRefreshing,
  onOpenDetails,
}: AlertBarProps) {
  const nowMs = useNow();
  const level = computeStatusLevel(streamState, lastContactAtMs, nowMs);

  if (!shouldShowAlertBar(level)) {
    return null;
  }

  const staleMinutes =
    lastContactAtMs !== null && lastContactAtMs !== undefined
      ? contactAgeMinutes(lastContactAtMs, nowMs)
      : null;

  const message =
    level === 'disconnected'
      ? '盤面データの接続が切断されています'
      : staleMinutes !== null
        ? `サーバーと約${staleMinutes}分前から通信できていません`
        : 'サーバーとの通信が遅延しています';

  return (
    <div className="alert-bar" role="status">
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
          詳細（{STATUS_LABELS[level]}）
        </button>
      </div>
    </div>
  );
}
