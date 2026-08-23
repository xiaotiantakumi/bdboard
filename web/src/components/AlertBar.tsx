import {
  computeStatusLevel,
  shouldShowAlertBar,
  staleAgeMinutes,
  STATUS_LABELS,
} from '../boardFreshness';
import { useNow } from '../hooks/useNow';
import type { StreamState } from '../useBoardStream';

export interface AlertBarProps {
  streamState: StreamState;
  generatedAt: string | null | undefined;
  onRefresh: () => void;
  isRefreshing: boolean;
  onOpenDetails: () => void;
}

export function AlertBar({
  streamState,
  generatedAt,
  onRefresh,
  isRefreshing,
  onOpenDetails,
}: AlertBarProps) {
  const nowMs = useNow();
  const level = computeStatusLevel(streamState, generatedAt, nowMs);

  if (!shouldShowAlertBar(level)) {
    return null;
  }

  const staleMinutes =
    generatedAt !== null && generatedAt !== undefined
      ? staleAgeMinutes(generatedAt, nowMs)
      : null;

  const message =
    level === 'disconnected'
      ? '盤面データの接続が切断されています'
      : staleMinutes !== null
        ? `盤面が約${staleMinutes}分前から更新されていません`
        : '盤面の更新が遅延しています';

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
