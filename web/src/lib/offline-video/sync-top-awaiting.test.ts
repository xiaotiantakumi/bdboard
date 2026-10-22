import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/http';
import { offlineVideoKey } from './key';
import {
  AUTO_VIDEO_CAP_BYTES,
  resetSyncTopAwaitingForTests,
  runAutoTopSync,
  syncTopAwaitingVideos,
  type SyncDependencies,
} from './sync-top-awaiting';
import type { OfflineVideoEntry, OfflineVideoStore } from './types';

function entry(ticketId: string, origin: 'auto' | 'manual', size = 20): OfflineVideoEntry {
  const path = `${ticketId}.mp4`;
  return { key: offlineVideoKey(ticketId, path), ticketId, path, origin, size, etag: 'e',
    savedAt: 1, lastPlayedAt: 0, bytesWritten: size, complete: true };
}

type FileListing = (ticketId: string) => Promise<{ files: { path: string; kind: 'video'; size: number | null }[] }>;

function setup(initial: OfflineVideoEntry[] = [], listFiles: FileListing = async () => ({ files: [] })) {
  let manifest = initial.slice();
  const removed: string[] = [];
  const store: OfflineVideoStore = {
    async readManifest() { return manifest; },
    async writeManifest(rows) { manifest = rows.slice(); },
    async writeChunk() {}, async truncate() {},
    async removeFile(key) { removed.push(key); },
    async listFiles() { return []; }, async getFile() { return null; },
  };
  const downloads: string[] = [];
  const deps: SyncDependencies = {
    store, fetchTicketLocalFiles: listFiles,
    async download(input) {
      downloads.push(input.ticketId);
      const row = entry(input.ticketId, 'auto', input.sizeHint ?? 0);
      manifest = [...manifest.filter((item) => item.key !== row.key), row];
      return row;
    },
    async fetchAtHome() { return 'yes'; },
    async fetch() { return new Response(null); },
  };
  return { deps, removed, downloads, manifest: () => manifest };
}

describe('上位3件の動画同期', () => {
  beforeEach(() => { resetSyncTopAwaitingForTests(); });

  it('上位3件外のautoだけを削除し、manualは残す', async () => {
    const rows = [entry('in', 'auto'), entry('out', 'auto'), entry('manual', 'manual')];
    const state = setup(rows);
    await syncTopAwaitingVideos(['in', 'top2', 'top3'], { auto: false }, state.deps);
    expect(state.removed).toEqual([rows[1]?.key]);
    expect(state.manifest().map((row) => row.ticketId)).toEqual(['in', 'manual']);
  });

  it.each(['no', 'unknown'] as const)('自宅以外(%s)では何もしない', async (home) => {
    const state = setup([entry('old', 'auto')]);
    const fetchAtHome = vi.fn(async () => home);
    const deps = { ...state.deps, fetchAtHome };
    await runAutoTopSync(['new'], {}, deps);
    expect(state.downloads).toEqual([]);
    expect(state.removed).toEqual([]);
    expect(fetchAtHome).toHaveBeenCalledOnce();
  });

  it('自動同期にも進捗を通知する', async () => {
    const state = setup();
    const onProgress = vi.fn();
    await runAutoTopSync(['new'], { onProgress }, state.deps);
    expect(onProgress).toHaveBeenLastCalledWith({ done: 1, total: 1, phase: 'done' });
  });

  it('空の上位リストでは自宅判定だけ行い同期しない', async () => {
    const state = setup([entry('old', 'auto')]);
    const fetchAtHome = vi.fn(async () => 'yes' as const);
    await runAutoTopSync([], {}, { ...state.deps, fetchAtHome });
    expect(fetchAtHome).toHaveBeenCalledOnce();
    expect(state.removed).toEqual([]);
  });

  it('上限を超えるファイルで停止し、その後のファイルは保存せずevictionする', async () => {
    const old = entry('old', 'auto', AUTO_VIDEO_CAP_BYTES - 10);
    const listing = vi.fn(async (ticketId: string) => ({ files: [
      { path: `${ticketId}.mp4`, kind: 'video' as const, size: 11 },
    ] }));
    const state = setup([old], listing);
    await syncTopAwaitingVideos(['first', 'later', 'top3'], { auto: false }, state.deps);
    expect(state.downloads).toEqual([]);
    expect(listing).toHaveBeenCalledTimes(1);
    expect(state.removed).toContain(old.key);
  });

  it('ファイル一覧取得の403を呼び出し元へ返しevictionしない', async () => {
    const old = entry('old', 'auto');
    const state = setup([old], async () => { throw new ApiError(403, 'forbidden'); });
    await expect(syncTopAwaitingVideos(['new'], { auto: false }, state.deps)).rejects.toMatchObject({ status: 403 });
    expect(state.removed).toEqual([]);
    expect(state.manifest()).toEqual([old]);
  });

  it('個別動画の失敗後も次の動画を保存し、evictionする', async () => {
    const listing = async () => ({ files: [
      { path: 'bad.mp4', kind: 'video' as const, size: 10 },
      { path: 'good.mp4', kind: 'video' as const, size: 10 },
    ] });
    const state = setup([entry('old', 'auto')], listing);
    const download = vi.fn(state.deps.download).mockRejectedValueOnce(new Error('quota'));
    await syncTopAwaitingVideos(['new'], { auto: false }, { ...state.deps, download });
    expect(download).toHaveBeenCalledTimes(2);
    expect(state.removed).toContain(offlineVideoKey('old', 'old.mp4'));
  });
});
