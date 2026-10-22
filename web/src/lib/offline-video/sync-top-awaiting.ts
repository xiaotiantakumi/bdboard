import { fetchAtHome, fetchTicketLocalFiles, localFileRawUrl } from '../../api/local-files';
import { ApiError } from '../../api/http';
import { downloadOfflineVideo, getOfflineVideoStore, OFFLINE_VIDEO_MAX_BYTES } from './index';
import { offlineVideoKey } from './key';
import type { OfflineVideoStore } from './types';

/** ボード読み込み時と表示復帰時に同期し、自動同期は設定が「はい」の場合だけ実行する。 */

export const AUTO_VIDEO_CAP_BYTES = 1536 * 1024 * 1024;
export interface SyncProgress {
  readonly done: number;
  readonly total: number;
  readonly phase: 'saving' | 'done' | 'stopped';
}
export interface SyncOptions { readonly auto: boolean; readonly onProgress?: (progress: SyncProgress) => void }
export interface AutoSyncOptions extends Pick<SyncOptions, 'onProgress'> {
  readonly home?: Promise<'yes' | 'no' | 'unknown'>;
}
export interface SyncDependencies {
  readonly store: OfflineVideoStore;
  readonly fetchTicketLocalFiles: typeof fetchTicketLocalFiles;
  readonly download: typeof downloadOfflineVideo;
  readonly fetchAtHome: typeof fetchAtHome;
  readonly fetch: typeof fetch;
}
const defaultDeps: Omit<SyncDependencies, 'store'> = {
  fetchTicketLocalFiles, download: downloadOfflineVideo,
  fetchAtHome, fetch: (...args) => fetch(...args),
};
function resolveDeps(deps: SyncDependencies | undefined): SyncDependencies {
  return deps ?? { ...defaultDeps, store: getOfflineVideoStore() };
}
let inFlight: Promise<void> | undefined;

export async function runAutoTopSync(
  top3TicketIds: readonly string[], options: AutoSyncOptions = {}, deps?: SyncDependencies,
): Promise<'yes' | 'no' | 'unknown'> {
  const resolved = resolveDeps(deps);
  const home = await (options.home ?? resolved.fetchAtHome());
  if (home === 'yes' && top3TicketIds.length > 0) {
    await syncTopAwaitingVideos(top3TicketIds, { ...options, auto: true }, resolved);
  }
  return home;
}

export function syncTopAwaitingVideos(
  top3TicketIds: readonly string[], options: SyncOptions, deps?: SyncDependencies,
): Promise<void> {
  const resolved = resolveDeps(deps);
  if (inFlight !== undefined) return inFlight;
  const task = sync(top3TicketIds.slice(0, 3), options, resolved);
  inFlight = task.finally(() => { inFlight = undefined; });
  return inFlight;
}

export function resetSyncTopAwaitingForTests(): void { inFlight = undefined; }

async function sync(ticketIds: readonly string[], options: SyncOptions, deps: SyncDependencies): Promise<void> {
  const current = new Set(ticketIds);
  const total = ticketIds.length;
  let done = 0;
  let stopped = false;
  for (const ticketId of ticketIds) {
      const { files } = await deps.fetchTicketLocalFiles(ticketId);
      for (const file of files) {
        // 大きさが分からない動画は 1.5 GiB の上限を確かめられないので自動保存しない。
        if (file.kind !== 'video' || file.size == null || file.size > OFFLINE_VIDEO_MAX_BYTES) continue;
        const key = offlineVideoKey(ticketId, file.path);
        const entries = await deps.store.readManifest();
        const existing = entries.find((entry) => entry.key === key);
        if (existing?.complete) continue;
        const used = entries.filter((entry) => entry.origin === 'auto')
          .reduce((sum, entry) => sum + entry.size, 0);
        const alreadyCounted = existing?.origin === 'auto' ? existing.size : 0;
        if (used - alreadyCounted + file.size > AUTO_VIDEO_CAP_BYTES) {
          stopped = true;
          break;
        }
        try {
          await deps.download({ ticketId, path: file.path, url: localFileRawUrl(ticketId, file.path),
            fetch: (url, init) => deps.fetch(url, init), store: deps.store, now: Date.now,
            sizeHint: file.size, origin: 'auto' });
        } catch (error) {
          if (isUnauthorized(error)) throw error;
          // 1本の失敗で残りの動画保存や古い自動保存の整理を止めない。
        }
      }
      if (stopped) break;
      done += 1;
      options.onProgress?.({ done, total, phase: 'saving' });
  }
  await evictOutsideTop(deps.store, current);
  options.onProgress?.({ done, total, phase: stopped ? 'stopped' : 'done' });
}

async function evictOutsideTop(store: OfflineVideoStore, current: ReadonlySet<string>): Promise<void> {
  const removed = (await store.readManifest()).filter(
    (entry) => entry.origin === 'auto' && !current.has(entry.ticketId),
  );
  if (removed.length === 0) return;
  for (const entry of removed) await store.removeFile(entry.key);
  const keys = new Set(removed.map((entry) => entry.key));
  // 削除の間に動画画面の「端末に保存」で manual になった行は台帳に残す (download が欠けたファイルを先頭から取り直す)。
  await store.writeManifest((await store.readManifest()).filter(
    (entry) => !(keys.has(entry.key) && entry.origin === 'auto'),
  ));
}

export function isUnauthorized(error: unknown): boolean {
  if (error instanceof ApiError && (error.status === 401 || error.status === 403)) return true;
  return error instanceof Error && error.name === 'OfflineVideoDownloadError' &&
    'reason' in error && error.reason === 'unauthorized';
}
