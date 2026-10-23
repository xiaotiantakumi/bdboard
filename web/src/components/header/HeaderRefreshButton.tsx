import { useEffect, useRef, useState } from 'react';

export interface HeaderRefreshButtonProps {
  onRefresh: () => void;
  isRefreshing: boolean;
}

const DONE_VISIBLE_MS = 2000;

/**
 * bdboard-1gue: 常時見える手動更新ボタン。更新中は回って無効になり、
 * 自分で押した更新が終わったら「更新しました」を短く出す (aria-live)。
 */
export function HeaderRefreshButton({ onRefresh, isRefreshing }: HeaderRefreshButtonProps) {
  const [done, setDone] = useState(false);
  const requestedRef = useRef(false);
  const wasRefreshingRef = useRef(false);

  useEffect(() => {
    const finished = wasRefreshingRef.current && !isRefreshing && requestedRef.current;
    wasRefreshingRef.current = isRefreshing;
    if (!finished) return undefined;
    requestedRef.current = false;
    setDone(true);
    const timer = setTimeout(() => setDone(false), DONE_VISIBLE_MS);
    return () => clearTimeout(timer);
  }, [isRefreshing]);

  return (
    <>
      <button
        type="button"
        className={`header-icon-btn header-refresh-btn${isRefreshing ? ' is-refreshing' : ''}`}
        aria-label="更新"
        disabled={isRefreshing}
        onClick={() => {
          requestedRef.current = true;
          onRefresh();
        }}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M21 12a9 9 0 1 1-3-6.7" />
          <path d="M21 3v6h-6" />
        </svg>
      </button>
      <span className="header-refresh-done" role="status" aria-live="polite">
        {done ? '更新しました' : ''}
      </span>
    </>
  );
}
