import { useEffect, useState } from 'react';

export function useElapsedSeconds(active: boolean): number {
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  useEffect(() => {
    if (!active) {
      setElapsedSeconds(0);
      return;
    }
    const startedAt = Date.now();
    setElapsedSeconds(0);
    const timer = setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000));
    }, 1_000);
    return () => clearInterval(timer);
  }, [active]);
  return elapsedSeconds;
}
