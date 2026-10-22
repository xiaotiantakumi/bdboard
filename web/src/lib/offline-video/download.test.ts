import { describe, expect, it } from 'vitest';
import {
  OFFLINE_VIDEO_CHUNK_BYTES,
  OFFLINE_VIDEO_MAX_BYTES,
  OfflineVideoDownloadError,
  downloadOfflineVideo,
  type DownloadOfflineVideoInput,
} from './download';
import type { OfflineVideoEntry, OfflineVideoStore } from './types';

const TICKET_ID = 'bdboard-hipq';
const FILE_PATH = 'clips/demo.mp4';
const RAW_URL = 'https://board.example/raw/demo.mp4';
const NOW = 1_700_000_000_000;
const ETAG = '"etag-1"';

function ownedBytes(values: readonly number[]): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(new ArrayBuffer(values.length));
  copy.set(values);
  return copy;
}

const PART = ownedBytes([10, 20, 30, 40]);
const REST = ownedBytes([50, 60, 70, 80]);
const TOTAL = PART.length + REST.length;

interface FetchCall {
  range: string | null;
  ifRange: string | null;
}

interface MemoryStore extends OfflineVideoStore {
  readonly files: Map<string, Uint8Array<ArrayBuffer>>;
  readonly snapshots: OfflineVideoEntry[][];
}

function createStore(): MemoryStore {
  const files = new Map<string, Uint8Array<ArrayBuffer>>();
  const snapshots: OfflineVideoEntry[][] = [];
  let manifest: OfflineVideoEntry[] = [];
  return {
    files,
    snapshots,
    async readManifest() {
      return manifest;
    },
    async writeManifest(entries) {
      manifest = entries.map((entry) => ({ ...entry }));
      snapshots.push(manifest.map((entry) => ({ ...entry })));
    },
    async writeChunk(key, offset, bytes) {
      const existing = files.get(key) ?? new Uint8Array(new ArrayBuffer(0));
      const next = new Uint8Array(
        new ArrayBuffer(Math.max(existing.byteLength, offset + bytes.byteLength)),
      );
      next.set(existing);
      next.set(bytes, offset);
      files.set(key, next);
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
}

function storage(): NonNullable<DownloadOfflineVideoInput['storage']> {
  return {
    estimate: async () => ({ quota: OFFLINE_VIDEO_MAX_BYTES * 4, usage: 0 }),
    persist: async () => true,
  };
}

function chunkResponse(
  body: Uint8Array<ArrayBuffer>,
  start: number,
  total: number,
  etag: string,
  status = 206,
): Response {
  const end = start + body.byteLength - 1;
  return new Response(body, {
    status,
    headers: {
      ETag: etag,
      'Content-Range': `bytes ${start}-${end}/${total}`,
    },
  });
}

function successfulDownload(etag = ETAG): Array<() => Response> {
  return [
    () => chunkResponse(PART, 0, TOTAL, etag),
    () => chunkResponse(REST, PART.length, TOTAL, etag),
  ];
}

function createFetch(responses: Array<() => Response>) {
  const calls: FetchCall[] = [];
  const fetch: DownloadOfflineVideoInput['fetch'] = async (_url, init) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({
      range: headers.Range ?? null,
      ifRange: headers['If-Range'] ?? null,
    });
    const build = responses[calls.length - 1];
    if (build === undefined) {
      throw new Error(`unexpected fetch ${calls.length}`);
    }
    return build();
  };
  return { fetch, calls };
}

function downloadInput(
  store: MemoryStore,
  fetch: DownloadOfflineVideoInput['fetch'],
  extra?: Partial<DownloadOfflineVideoInput>,
): DownloadOfflineVideoInput {
  return {
    ticketId: TICKET_ID,
    path: FILE_PATH,
    url: RAW_URL,
    fetch,
    store,
    now: () => NOW,
    storage: storage(),
    ...extra,
  };
}

function expectComplete(result: OfflineVideoEntry, store: MemoryStore): void {
  expect(result.complete).toBe(true);
  expect(result.bytesWritten).toBe(result.size);
  expect(result.size).toBe(TOTAL);
  expect(Array.from(store.files.get(result.key) ?? [])).toEqual([...PART, ...REST]);
}

async function expectRestartThenSuccess(failure: () => Response): Promise<void> {
  const store = createStore();
  const script = createFetch([
    () => chunkResponse(PART, 0, TOTAL, ETAG),
    failure,
    ...successfulDownload(),
  ]);
  const result = await downloadOfflineVideo(downloadInput(store, script.fetch));

  expectComplete(result, store);
  expect(script.calls).toHaveLength(4);
  expect(script.calls[0]?.ifRange).toBeNull();
  expect(script.calls[1]?.ifRange).toBe(ETAG);
  expect(script.calls[2]?.ifRange).toBeNull();
  expect(script.calls[2]?.range).toBe(`bytes=0-${OFFLINE_VIDEO_CHUNK_BYTES - 1}`);
  expect(script.calls[3]?.ifRange).toBe(ETAG);
}

describe('downloadOfflineVideo', () => {
  it('completes when every range matches and leaves earlier manifests incomplete', async () => {
    const store = createStore();
    const script = createFetch(successfulDownload());
    const result = await downloadOfflineVideo(downloadInput(store, script.fetch));

    expectComplete(result, store);
    // 先頭はファイルを作る前に書く空の台帳行 (掃除に孤児として消されないため)。
    expect(store.snapshots.map((entries) => entries[0]?.complete)).toEqual([false, false, true]);
    expect(store.snapshots[0]?.[0]?.bytesWritten).toBe(0);
    expect(store.snapshots[1]?.[0]?.bytesWritten).toBe(PART.length);
    expect(script.calls).toHaveLength(2);
    expect(script.calls[0]?.ifRange).toBeNull();
    expect(script.calls[0]?.range).toBe(`bytes=0-${OFFLINE_VIDEO_CHUNK_BYTES - 1}`);
    expect(script.calls[1]?.ifRange).toBe(ETAG);
    expect(script.calls[1]?.range).toBe(
      `bytes=${PART.length}-${PART.length + OFFLINE_VIDEO_CHUNK_BYTES - 1}`,
    );
  });

  it('auto never downgrades manual', async () => {
    const store = createStore();
    await downloadOfflineVideo(downloadInput(store, createFetch(successfulDownload()).fetch));
    const script = createFetch([]);
    const result = await downloadOfflineVideo(downloadInput(store, script.fetch, { origin: 'auto' }));
    expect(result.origin).toBe('manual');
    expect(script.calls).toHaveLength(0);
  });

  it('restarts from offset 0 when the second response changes ETag', async () => {
    await expectRestartThenSuccess(() =>
      chunkResponse(REST, PART.length, TOTAL, '"etag-2"'),
    );
  });

  it('restarts from offset 0 when the second response is 200', async () => {
    await expectRestartThenSuccess(
      () => new Response(REST, { status: 200, headers: { ETag: ETAG } }),
    );
  });

  it('restarts from offset 0 when Content-Range start is not the requested offset', async () => {
    await expectRestartThenSuccess(() => chunkResponse(REST, 0, TOTAL, ETAG));
  });

  it('restarts from offset 0 when Content-Range total differs from the manifest size', async () => {
    await expectRestartThenSuccess(() =>
      chunkResponse(REST, PART.length, TOTAL + 10, ETAG),
    );
  });

  it('throws restart-failed when the download fails again after restarting', async () => {
    const store = createStore();
    const script = createFetch([
      () => chunkResponse(PART, 0, TOTAL, ETAG),
      () => new Response(REST, { status: 200, headers: { ETag: ETAG } }),
      () => new Response(PART, { status: 200, headers: { ETag: ETAG } }),
    ]);

    const error = await downloadOfflineVideo(downloadInput(store, script.fetch)).then(
      () => null,
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(OfflineVideoDownloadError);
    expect((error as OfflineVideoDownloadError).reason).toBe('restart-failed');
    expect(script.calls).toHaveLength(3);
    expect(script.calls[2]?.range).toBe(`bytes=0-${OFFLINE_VIDEO_CHUNK_BYTES - 1}`);
    expect(script.calls[2]?.ifRange).toBeNull();
  });

  it('throws too-large when sizeHint exceeds 1 GiB', async () => {
    const store = createStore();
    let fetched = false;
    const fetch: DownloadOfflineVideoInput['fetch'] = async () => {
      fetched = true;
      return new Response(null, { status: 206 });
    };

    const error = await downloadOfflineVideo(
      downloadInput(store, fetch, { sizeHint: OFFLINE_VIDEO_MAX_BYTES + 1 }),
    ).then(
      () => null,
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(OfflineVideoDownloadError);
    expect((error as OfflineVideoDownloadError).reason).toBe('too-large');
    expect(fetched).toBe(false);
    expect(store.snapshots).toHaveLength(0);
  });
});
