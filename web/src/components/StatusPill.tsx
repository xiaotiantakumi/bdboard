import { useEffect, useRef } from 'react';
import {
  computeStatusLevel,
  formatGeneratedAtAge,
  formatRelativeAge,
  STATUS_LABELS,
  type StatusLevel,
} from '../boardFreshness';
import { useNow } from '../hooks/useNow';
import type { StreamState } from '../useBoardStream';

export interface StatusPillProps {
  streamState: StreamState;
  lastContactAtMs: number | null | undefined;
  generatedAt: string | null | undefined;
  lastRefreshAt: string | null | undefined;
  totalSessionCount: number;
  activeSessionCount: number;
  onOpenSessionList: () => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function statusPillClass(level: StatusLevel): string {
  switch (level) {
    case 'ok':
      return 'status-pill status-pill-ok';
    case 'delayed':
      return 'status-pill status-pill-delayed';
    case 'disconnected':
      return 'status-pill status-pill-disconnected';
    case 'reconnecting':
      return 'status-pill status-pill-reconnecting';
  }
}

export function StatusPill({
  streamState,
  lastContactAtMs,
  generatedAt,
  lastRefreshAt,
  totalSessionCount,
  activeSessionCount,
  onOpenSessionList,
  open,
  onOpenChange,
}: StatusPillProps) {
  const nowMs = useNow();
  const containerRef = useRef<HTMLDivElement>(null);
  const level = computeStatusLevel(streamState, lastContactAtMs, nowMs);

  useEffect(() => {
    if (!open) {
      return;
    }

    const handleMouseDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }
      if (containerRef.current !== null && !containerRef.current.contains(target)) {
        onOpenChange(false);
      }
    };

    document.addEventListener('mousedown', handleMouseDown);
    return () => {
      document.removeEventListener('mousedown', handleMouseDown);
    };
  }, [open, onOpenChange]);

  return (
    <div ref={containerRef} className="status-pill-widget header-group">
      <button
        type="button"
        className={statusPillClass(level)}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={`接続状態: ${STATUS_LABELS[level]}`}
        onClick={() => {
          onOpenChange(!open);
        }}
      >
        {STATUS_LABELS[level]}
      </button>

      {open && (
        <div className="status-pill-popover" role="region" aria-label="接続状態の詳細">
          {/* ピルの判定は bdboard-9qa 以降 lastContactAtMs 基準なのに、ここだけ
              generatedAt を「盤面取得」と表示していた。静穏時 (ETag 304 が続いて
              generatedAt が凍る) には「正常」ピルの中に「盤面取得: 10分前」が
              同居し、通信が10分止まっているようにも読めてしまう。ラベルを内容の
              鮮度だと分かる語に変え、通信の鮮度を並記して両者を1画面で
              読み分けられるようにする (bdboard-d55)。 */}
          {generatedAt !== null && generatedAt !== undefined && (
            <p className="status-pill-detail" title={new Date(generatedAt).toLocaleString()}>
              盤面内容の最終変化: {formatGeneratedAtAge(generatedAt, nowMs)}
            </p>
          )}
          {lastContactAtMs !== null && lastContactAtMs !== undefined && (
            <p
              className="status-pill-detail"
              title={new Date(lastContactAtMs).toLocaleString()}
            >
              最終通信: {formatRelativeAge(lastContactAtMs, nowMs)}
            </p>
          )}
          {lastRefreshAt !== null && lastRefreshAt !== undefined && (
            <p className="status-pill-detail">
              最終更新: {new Date(lastRefreshAt).toLocaleString()}
            </p>
          )}
          <button
            type="button"
            className="status-pill-session-btn"
            onClick={() => {
              onOpenSessionList();
            }}
          >
            セッション: {totalSessionCount}（稼働中 {activeSessionCount}）
          </button>
        </div>
      )}
    </div>
  );
}
