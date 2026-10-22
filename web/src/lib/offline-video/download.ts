import { offlineVideoKey } from './key';
import type { OfflineVideoEntry, OfflineVideoStore } from './types';

/** Range 1 本の長さ。 */
export const OFFLINE_VIDEO_CHUNK_BYTES = 4 * 1024 * 1024;

/** これを超える動画は保存しない。 */
export const OFFLINE_VIDEO_MAX_BYTES = 1024 * 1024 * 1024;

/** `quota - usage` が残りバイト数に加えて必要な空き。 */
export const OFFLINE_VIDEO_QUOTA_MARGIN_BYTES = 200 * 1024 * 1024;

/** `navigator.storage` の代わりにテストから渡す。 */
export interface OfflineVideoStorageManager {
  estimate?: () => Promise<{ quota?: number; usage?: number }>;
  persist?: () => Promise<boolean>;
}

export type OfflineVideoDownloadFailure = 'too-large' | 'quota' | 'restart-failed' | 'unauthorized';

export class OfflineVideoDownloadError extends Error {
  readonly reason: OfflineVideoDownloadFailure;

  constructor(message: string, reason: OfflineVideoDownloadFailure) {
    super(message);
    this.name = 'OfflineVideoDownloadError';
    this.reason = reason;
  }
}

export interface DownloadOfflineVideoInput {
  ticketId: string;
  path: string;
  /** `localFileRawUrl` で組んだ raw URL。テストはここを差し替える。 */
  url: string;
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  store: OfflineVideoStore;
  now: () => number;
  onProgress?: (entry: OfflineVideoEntry) => void;
  sizeHint?: number | null;
  origin?: 'manual' | 'auto';
  storage?: OfflineVideoStorageManager;
}

interface ChunkMeta {
  readonly etag: string;
  readonly total: number;
}

const CONTENT_RANGE_PATTERN = /^bytes (\d+)-(\d+)\/(\d+)$/i;

/**
 * 4 MiB の Range で動画を取り込み、チャンクごとに manifest を更新する。
 * 先頭チャンクは If-Range を付けず、応答の ETag と総サイズを台帳に書く。
 * 206 / ETag / Content-Range の start と total が一致しないときは部分ファイルを捨て、
 * 先頭から 1 回だけやり直す。2 回目もダメならエラー。
 * 401 / 403 は再開も truncate もせず unauthorized で終わる。保存済みのバイトは残す。
 * `complete` は `bytesWritten === size` のときだけ true。
 */
export async function downloadOfflineVideo(input: DownloadOfflineVideoInput): Promise<OfflineVideoEntry> {
  const storage = input.storage ?? navigator.storage;
  const key = offlineVideoKey(input.ticketId, input.path);
  const existing = (await input.store.readManifest()).find((entry) => entry.key === key);
  let entry =
    existing ?? blankEntry(key, input.ticketId, input.path, input.now());
  const requestedOrigin = input.origin ?? 'manual';
  const nextOrigin = existing?.origin === 'manual' ? 'manual' : requestedOrigin;
  if (entry.origin !== nextOrigin) {
    entry = { ...entry, origin: nextOrigin };
    await writeEntry(input.store, entry);
  }
  if (existing !== undefined && existing.bytesWritten > 0) {
    // 台帳だけ残ってファイルが消えた/短いときは、途中から書かずに先頭からやり直す。
    const file = await input.store.getFile(key);
    if (file === null || file.size < existing.bytesWritten) {
      entry = { ...entry, bytesWritten: 0, complete: false, etag: '', size: 0 };
      await input.store.truncate(key);
      await writeEntry(input.store, entry);
    }
  }

  const hinted = entry.size > 0 ? entry.size : positive(input.sizeHint);
  if (hinted > OFFLINE_VIDEO_MAX_BYTES) {
    throw new OfflineVideoDownloadError('offline video exceeds 1 GiB', 'too-large');
  }
  if (hinted > 0) {
    await ensureQuota(storage, hinted - entry.bytesWritten);
  }
  await persistOnce(storage);
  if (existing === undefined) {
    // ファイルより先に台帳行を作る。行の無いファイルは掃除が孤児として消すため。
    await writeEntry(input.store, entry);
  }

  let restartsUsed = 0;
  while (entry.size === 0 || entry.bytesWritten < entry.size) {
    const offset = entry.bytesWritten;
    const response = await input.fetch(input.url, {
      credentials: 'same-origin',
      headers: rangeHeaders(offset, entry.etag),
    });
    if (response.status === 401 || response.status === 403) {
      throw new OfflineVideoDownloadError('offline video download is not authorized', 'unauthorized');
    }
    const meta = readAcceptedMeta(response, offset, entry);
    if (meta === null || meta.total > OFFLINE_VIDEO_MAX_BYTES) {
      if (meta !== null && meta.total > OFFLINE_VIDEO_MAX_BYTES) {
        await input.store.truncate(entry.key);
        throw new OfflineVideoDownloadError('offline video exceeds 1 GiB', 'too-large');
      }
      entry = await restartOrThrow(input.store, entry, restartsUsed);
      restartsUsed += 1;
      continue;
    }
    if (offset === 0) {
      await ensureQuota(storage, meta.total);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength === 0 || offset + bytes.byteLength > meta.total) {
      entry = await restartOrThrow(input.store, entry, restartsUsed);
      restartsUsed += 1;
      continue;
    }
    if (offset === 0) {
      // 以前の版の残りバイトが後ろに残ったまま complete にしない。
      await input.store.truncate(entry.key);
    }
    await input.store.writeChunk(entry.key, offset, bytes);
    const bytesWritten = offset + bytes.byteLength;
    entry = {
      ...entry,
      etag: meta.etag,
      size: meta.total,
      bytesWritten,
      complete: bytesWritten === meta.total,
    };
    await writeEntry(input.store, entry);
    input.onProgress?.(entry);
  }
  return entry;
}

function blankEntry(key: string, ticketId: string, path: string, savedAt: number): OfflineVideoEntry {
  return {
    key,
    ticketId,
    path,
    size: 0,
    etag: '',
    savedAt,
    lastPlayedAt: 0,
    origin: 'manual',
    bytesWritten: 0,
    complete: false,
  };
}

function positive(value: number | null | undefined): number {
  return value != null && value > 0 ? value : 0;
}

function rangeHeaders(offset: number, etag: string): Record<string, string> {
  const headers: Record<string, string> = {
    Range: `bytes=${offset}-${offset + OFFLINE_VIDEO_CHUNK_BYTES - 1}`,
  };
  if (offset > 0 && etag !== '') {
    headers['If-Range'] = etag;
  }
  return headers;
}

function readAcceptedMeta(response: Response, offset: number, entry: OfflineVideoEntry): ChunkMeta | null {
  if (response.status !== 206) return null;
  const etag = response.headers.get('etag');
  if (etag === null || etag === '') return null;
  const range = parseContentRange(response.headers.get('content-range'));
  if (range === null || range.start !== offset) return null;
  if (offset > 0 && (etag !== entry.etag || range.total !== entry.size)) return null;
  return { etag, total: range.total };
}

function parseContentRange(header: string | null): { start: number; end: number; total: number } | null {
  if (header === null) return null;
  const match = CONTENT_RANGE_PATTERN.exec(header.trim());
  if (match === null) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = Number(match[3]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || !Number.isSafeInteger(total)) {
    return null;
  }
  if (end < start || total <= end) return null;
  return { start, end, total };
}

async function ensureQuota(storage: OfflineVideoStorageManager | undefined, remaining: number): Promise<void> {
  if (storage?.estimate === undefined) return;
  const estimate = await storage.estimate();
  const { quota, usage } = estimate;
  if (quota === undefined || usage === undefined) return;
  if (quota - usage < remaining + OFFLINE_VIDEO_QUOTA_MARGIN_BYTES) {
    throw new OfflineVideoDownloadError('not enough free storage for offline video', 'quota');
  }
}

async function persistOnce(storage: OfflineVideoStorageManager | undefined): Promise<void> {
  try {
    await storage?.persist?.();
  } catch {
    // 永続化の拒否や未実装は保存を止めない。
  }
}

async function restartOrThrow(
  store: OfflineVideoStore,
  entry: OfflineVideoEntry,
  restartsUsed: number,
): Promise<OfflineVideoEntry> {
  const reset: OfflineVideoEntry = { ...entry, bytesWritten: 0, complete: false, etag: '', size: 0 };
  await store.truncate(entry.key);
  await writeEntry(store, reset);
  if (restartsUsed >= 1) {
    throw new OfflineVideoDownloadError(
      'offline video download failed again after restarting from the beginning',
      'restart-failed',
    );
  }
  return reset;
}

async function writeEntry(store: OfflineVideoStore, entry: OfflineVideoEntry): Promise<void> {
  const entries = [...(await store.readManifest())];
  const index = entries.findIndex((item) => item.key === entry.key);
  if (index === -1) entries.push(entry);
  else entries[index] = entry;
  await store.writeManifest(entries);
}
