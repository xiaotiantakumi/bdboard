import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchAtHome } from '../../api/local-files';
import { isUnauthorized, runAutoTopSync, syncTopAwaitingVideos, type SyncProgress } from './sync-top-awaiting';

/** ボード読み込み時と表示復帰時に同期し、自動同期は設定が「はい」の場合だけ実行する。 */

export function useTopAwaitingVideoSync(ticketIds: readonly string[], enabled: boolean, supported: boolean) {
  const [home, setHome] = useState<'yes' | 'no' | 'unknown' | null>(null);
  const [progress, setProgress] = useState<SyncProgress | null>(null);
  const [authenticated, setAuthenticated] = useState(false);
  const [failed, setFailed] = useState(false);
  const homeProbe = useRef<Promise<'yes' | 'no' | 'unknown'> | null>(null);
  const lastAuto = useRef<{ key: string; at: number } | null>(null);
  const idsKey = ticketIds.join('\0');
  useEffect(() => {
    if (!supported) return;
    let active = true;
    const probe = homeProbe.current ?? fetchAtHome();
    homeProbe.current = probe;
    void probe.then((result) => {
      if (!active) return;
      setAuthenticated(true);
      setHome(result);
    }).catch((error: unknown) => {
      if (!active) return;
      if (isUnauthorized(error)) setAuthenticated(false);
      else { setAuthenticated(true); setHome('unknown'); }
    });
    return () => { active = false; };
  }, [supported]);
  useEffect(() => {
    if (!supported) return;
    let active = true;
    const run = async (force = false) => {
      // マウント時の判定は最初の 1 回だけ使う。前面復帰時は外出先かもしれないので毎回聞き直す。
      // 早期 return より前で捨てる: 設定を後からオンにしたときに古い「自宅」を使わないため。
      const reused = homeProbe.current ?? undefined;
      homeProbe.current = null;
      if (!enabled || ticketIds.length === 0) return;
      const now = Date.now();
      if (!force && lastAuto.current?.key === idsKey && now - lastAuto.current.at < 30_000) return;
      lastAuto.current = { key: idsKey, at: now };
      try {
        setFailed(false);
        const result = await runAutoTopSync(ticketIds, { onProgress: setProgress, home: reused });
        if (active) { setHome(result); setAuthenticated(true); }
      } catch (error) {
        if (!active) return;
        if (isUnauthorized(error)) setAuthenticated(false);
        else { setHome('unknown'); setFailed(true); }
      }
    };
    void run();
    const onVisibility = () => { if (document.visibilityState === 'visible') void run(true); };
    document.addEventListener('visibilitychange', onVisibility);
    return () => { active = false; document.removeEventListener('visibilitychange', onVisibility); };
    // ID内容をキーにすることで、同じトップ3の配列再生成ではeffectを再実行しない。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, idsKey, supported]);
  const save = useCallback(async () => {
    try {
      setFailed(false);
      await syncTopAwaitingVideos(ticketIds, { auto: false, onProgress: setProgress });
    } catch (error) {
      if (isUnauthorized(error)) setAuthenticated(false);
      else setFailed(true);
      throw error;
    }
    // 同じID内容の配列差し替えでは再生成しない。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey]);
  return { home, progress, save, authenticated, failed };
}
