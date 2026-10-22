import { describe, expect, it } from 'vitest';
import {
  OFFLINE_VIDEO_STALE_INCOMPLETE_MS,
  OFFLINE_VIDEO_TTL_MS,
  sweepOfflineVideos,
} from './sweep';
import type { OfflineVideoEntry, OfflineVideoStore } from './types';

const NOW = 1_700_000_000_000;

interface MemoryStore extends OfflineVideoStore {
  readonly files: Map<string, Uint8Array<ArrayBuffer>>;
  manifestWrites: number;
  manifest(): OfflineVideoEntry[];
}

function entry(overrides: Partial<OfflineVideoEntry> & Pick<OfflineVideoEntry, 'key'>): OfflineVideoEntry {
  return {
    ticketId: 'bdboard-hipq',
    path: 'clips/demo.mp4',
    size: 4,
    etag: '"etag-1"',
    savedAt: NOW,
    lastPlayedAt: NOW,
    origin: 'manual',
    bytesWritten: 4,
    complete: true,
    ...overrides,
  };
}

function createStore(entries: readonly OfflineVideoEntry[], fileKeys: readonly string[]): MemoryStore {
  const files = new Map<string, Uint8Array<ArrayBuffer>>();
  for (const key of fileKeys) {
    const bytes = new Uint8Array(new ArrayBuffer(1));
    bytes[0] = 1;
    files.set(key, bytes);
  }
  let manifest = entries.map((item) => ({ ...item }));
  const store: MemoryStore = {
    files,
    manifestWrites: 0,
    manifest() {
      return manifest.map((item) => ({ ...item }));
    },
    async readManifest() {
      return manifest.map((item) => ({ ...item }));
    },
    async writeManifest(next) {
      store.manifestWrites += 1;
      manifest = next.map((item) => ({ ...item }));
    },
    async writeChunk(key, offset, bytes) {
      const existing = files.get(key) ?? new Uint8Array(new ArrayBuffer(0));
      const merged = new Uint8Array(
        new ArrayBuffer(Math.max(existing.byteLength, offset + bytes.byteLength)),
      );
      merged.set(existing);
      merged.set(bytes, offset);
      files.set(key, merged);
    },
    async truncate(key) {
      files.set(key, new Uint8Array(new ArrayBuffer(0)));
    },
    async removeFile(key) {
      files.delete(key);
    },
    async listFiles() {
      return [...files.keys()];
    },
    async getFile(key) {
      const bytes = files.get(key);
      if (bytes === undefined) return null;
      return new File([bytes], `${key}.mp4`);
    },
  };
  return store;
}

describe('sweepOfflineVideos', () => {
  it('drops expired rows and orphan files, and keeps fresh or recently played ones', async () => {
    const expiredComplete = entry({
      key: 'expired-complete',
      savedAt: NOW - OFFLINE_VIDEO_TTL_MS - 1,
      lastPlayedAt: NOW - OFFLINE_VIDEO_TTL_MS - 1,
    });
    const staleIncomplete = entry({
      key: 'stale-incomplete',
      savedAt: NOW - OFFLINE_VIDEO_STALE_INCOMPLETE_MS - 1,
      lastPlayedAt: NOW - OFFLINE_VIDEO_STALE_INCOMPLETE_MS - 1,
      complete: false,
      bytesWritten: 1,
    });
    const freshComplete = entry({ key: 'fresh-complete' });
    const freshIncomplete = entry({
      key: 'fresh-incomplete',
      complete: false,
      bytesWritten: 1,
    });
    const playedRecently = entry({
      key: 'played-recently',
      savedAt: NOW - OFFLINE_VIDEO_TTL_MS - 1,
      lastPlayedAt: NOW,
    });
    const withinCompleteWindow = entry({
      key: 'within-complete-window',
      savedAt: NOW - OFFLINE_VIDEO_STALE_INCOMPLETE_MS - 1,
      lastPlayedAt: NOW - OFFLINE_VIDEO_STALE_INCOMPLETE_MS - 1,
    });
    const kept = [freshComplete, freshIncomplete, playedRecently, withinCompleteWindow];
    const store = createStore(
      [expiredComplete, staleIncomplete, ...kept],
      [...kept.map((item) => item.key), expiredComplete.key, staleIncomplete.key, 'orphan-file'],
    );

    const first = await sweepOfflineVideos(NOW, store);

    expect(first.removed).toEqual(['expired-complete', 'stale-incomplete', 'orphan-file']);
    expect(store.manifest().map((item) => item.key)).toEqual(kept.map((item) => item.key));
    expect([...store.files.keys()]).toEqual(kept.map((item) => item.key));
    expect(store.manifestWrites).toBe(1);

    const manifestAfter = store.manifest();
    const filesAfter = [...store.files.keys()];
    const second = await sweepOfflineVideos(NOW, store);

    expect(second.removed).toEqual([]);
    expect(store.manifest()).toEqual(manifestAfter);
    expect([...store.files.keys()]).toEqual(filesAfter);
    expect(store.manifestWrites).toBe(1);
  });
});
