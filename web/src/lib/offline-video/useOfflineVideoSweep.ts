import { useEffect } from 'react';
import { getOfflineVideoStore, isOfflineVideoSupported } from './opfs-store';
import { sweepOfflineVideos } from './sweep';

let sweepInFlight = false;

async function runOfflineVideoSweep(): Promise<void> {
  if (!isOfflineVideoSupported() || sweepInFlight) return;
  sweepInFlight = true;
  try {
    await sweepOfflineVideos(Date.now(), getOfflineVideoStore());
  } catch {
    // 期限切れの掃除に失敗しても、再生と保存はそのまま続ける。
  } finally {
    sweepInFlight = false;
  }
}

/** マウント時に 1 回と、タブが再び見えるたびに期限切れの保存動画を捨てる。 */
export function useOfflineVideoSweep(): void {
  useEffect(() => {
    void runOfflineVideoSweep();
    const onVisibilityChange = () => {
      if (document.visibilityState !== 'visible') return;
      void runOfflineVideoSweep();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, []);
}
