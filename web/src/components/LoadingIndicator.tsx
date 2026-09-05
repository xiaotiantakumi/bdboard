import { useEffect, useState } from 'react';

export interface LoadingIndicatorProps {
  readonly label?: string;
  readonly showElapsedAfterMs?: number;
}

export function LoadingIndicator({
  label = '読み込み中…',
  showElapsedAfterMs = 2000,
}: LoadingIndicatorProps) {
  const [elapsedSeconds, setElapsedSeconds] = useState<number | null>(null);

  useEffect(() => {
    const startedAt = Date.now();
    const intervalId = setInterval(() => {
      const elapsedMs = Date.now() - startedAt;
      if (elapsedMs > showElapsedAfterMs) {
        setElapsedSeconds(Math.floor(elapsedMs / 1000));
      }
    }, 1000);

    return () => {
      clearInterval(intervalId);
    };
  }, [showElapsedAfterMs]);

  return (
    <p className="loading" role="status" aria-live="polite">
      <span>{label}</span>
      {elapsedSeconds !== null && <span>{` (${elapsedSeconds}秒経過)`}</span>}
    </p>
  );
}
