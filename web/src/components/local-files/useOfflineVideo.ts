import { useCallback, useEffect, useRef, useState } from 'react';
import { localFileRawUrl } from '../../api/local-files';
import {
  OfflineVideoDownloadError,
  type OfflineVideoEntry,
  downloadOfflineVideo,
  getOfflineVideoStore,
  offlineVideoKey,
  probeOfflineVideoSupport,
} from '../../lib/offline-video';

// Worker が複数あると同じファイルの sync handle が衝突するため、ストアは 1 個を共有する。
const store = getOfflineVideoStore();

export interface UseOfflineVideoResult {
  readonly supported: boolean;
  readonly entry: OfflineVideoEntry | null;
  readonly progress: number | null;
  readonly error: string | null;
  readonly blobUrl: string | null;
  readonly saveBlocked: boolean;
  save: () => void;
  remove: () => void;
  markPlayed: () => void;
}

export function useOfflineVideo(
  ticketId: string,
  path: string,
  enabled: boolean,
  sizeHint?: number | null,
  onChange?: () => void,
): UseOfflineVideoResult {
  const [supported, setSupported] = useState(false);
  const [entry, setEntry] = useState<OfflineVideoEntry | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [saveBlocked, setSaveBlocked] = useState(false);
  const epoch = useRef(0);
  const busy = useRef(false);
  const blobUrlRef = useRef<string | null>(null);
  const sourceKey = `${ticketId}\0${path}`;
  const [sourceKeySeen, setSourceKeySeen] = useState(sourceKey);
  if (sourceKeySeen !== sourceKey) {
    setSourceKeySeen(sourceKey);
    setEntry(null);
    setProgress(null);
    setError(null);
    setSaveBlocked(false);
    setBlobUrl(null);
  }

  const adoptCompleteFile = useCallback(async (saved: OfflineVideoEntry, token: number): Promise<void> => {
    const file = await store.getFile(saved.key);
    // 長さが台帳と違うファイルは壊れているので端末再生に使わない (ネットワーク再生のまま)。
    if (epoch.current !== token || file === null || file.size !== saved.size) return;
    const url = URL.createObjectURL(file.slice(0, saved.size, 'video/mp4'));
    if (epoch.current !== token) {
      URL.revokeObjectURL(url);
      return;
    }
    if (blobUrlRef.current !== null) URL.revokeObjectURL(blobUrlRef.current);
    blobUrlRef.current = url;
    setBlobUrl(url);
  }, []);

  useEffect(() => {
    if (!enabled) {
      setSupported(false);
      return;
    }
    let cancelled = false;
    void probeOfflineVideoSupport().then((ok) => {
      if (!cancelled) setSupported(ok);
    });
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  useEffect(() => {
    const token = epoch.current;
    let cancelled = false;
    if (enabled && supported) {
      const key = offlineVideoKey(ticketId, path);
      void (async () => {
        try {
          const manifest = await store.readManifest();
          if (cancelled || epoch.current !== token) return;
          const found = manifest.find((item) => item.key === key) ?? null;
          setEntry(found);
          if (found?.complete !== true) return;
          await adoptCompleteFile(found, token);
        } catch {
          // 台帳が読めなくてもネットワーク再生は続ける。
        }
      })();
    }
    return () => {
      cancelled = true;
      epoch.current += 1;
      if (blobUrlRef.current !== null) {
        URL.revokeObjectURL(blobUrlRef.current);
        blobUrlRef.current = null;
        setBlobUrl(null);
      }
    };
  }, [adoptCompleteFile, enabled, path, supported, ticketId]);

  const save = useCallback(() => {
    if (!enabled || !supported || saveBlocked || busy.current) return;
    busy.current = true;
    const token = ++epoch.current;
    setError(null);
    setProgress(0);
    void (async () => {
      try {
        const result = await downloadOfflineVideo({
          ticketId,
          path,
          url: localFileRawUrl(ticketId, path),
          fetch: (url, init) => fetch(url, init),
          store,
          now: Date.now,
          sizeHint,
          onProgress: (next) => {
            if (epoch.current !== token) return;
            setEntry(next);
            setProgress(downloadPercent(next));
          },
        });
        if (epoch.current !== token) return;
        setEntry(result);
        if (result.complete) {
          await adoptCompleteFile(result, token);
          onChange?.();
        }
        if (epoch.current !== token) return;
        setProgress(null);
      } catch (caught) {
        if (epoch.current !== token) return;
        setProgress(null);
        if (caught instanceof OfflineVideoDownloadError && caught.reason === 'unauthorized') {
          setSaveBlocked(true);
          return;
        }
        setError(offlineSaveErrorMessage(caught));
      } finally {
        busy.current = false;
      }
    })();
  }, [adoptCompleteFile, enabled, onChange, path, saveBlocked, sizeHint, supported, ticketId]);

  const remove = useCallback(() => {
    if (busy.current) return;
    busy.current = true;
    const token = ++epoch.current;
    const key = offlineVideoKey(ticketId, path);
    void (async () => {
      try {
        await store.removeFile(key);
        const current = await store.readManifest();
        await store.writeManifest(current.filter((item) => item.key !== key));
        if (epoch.current !== token) return;
        if (blobUrlRef.current !== null) {
          URL.revokeObjectURL(blobUrlRef.current);
          blobUrlRef.current = null;
        }
        setBlobUrl(null);
        setEntry(null);
        setProgress(null);
        setError(null);
        onChange?.();
      } catch {
        if (epoch.current !== token) return;
        setError('端末から削除できませんでした');
      } finally {
        busy.current = false;
      }
    })();
  }, [onChange, path, ticketId]);

  const markPlayed = useCallback(() => {
    const token = epoch.current;
    const key = offlineVideoKey(ticketId, path);
    void (async () => {
      try {
        const current = await store.readManifest();
        const found = current.find((item) => item.key === key);
        if (found === undefined) return;
        const updated: OfflineVideoEntry = { ...found, lastPlayedAt: Date.now() };
        await store.writeManifest(current.map((item) => (item.key === key ? updated : item)));
        if (epoch.current !== token) return;
        setEntry(updated);
      } catch {
        // 再生記録の失敗では再生を止めない。
      }
    })();
  }, [path, ticketId]);

  return { supported, entry, progress, error, blobUrl, saveBlocked, save, remove, markPlayed };
}

function downloadPercent(entry: OfflineVideoEntry): number {
  if (entry.size <= 0) return 0;
  return Math.min(100, Math.round((entry.bytesWritten * 100) / entry.size));
}

function offlineSaveErrorMessage(error: unknown): string {
  if (error instanceof OfflineVideoDownloadError) {
    if (error.reason === 'too-large') return '1 GiB を超える動画は保存できません';
    if (error.reason === 'quota') return '端末の空き容量が足りません';
  }
  return '保存に失敗しました';
}
