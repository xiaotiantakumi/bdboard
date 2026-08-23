import { useEffect, useState } from 'react';

const DEFAULT_INTERVAL_MS = 30_000;

/**
 * 盤面の鮮度表示など、経過時間に応じて再レンダーが必要な UI 向けの現在時刻。
 */
export function useNow(intervalMs = DEFAULT_INTERVAL_MS): number {
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => {
      setNowMs(Date.now());
    }, intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);

  return nowMs;
}
