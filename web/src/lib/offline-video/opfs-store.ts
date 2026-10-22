import type { OfflineVideoEntry, OfflineVideoStore } from './types';
import type { WriterCommand, WriterRequest, WriterResponse } from './opfs-writer.worker';

const DIR_NAME = 'offline-videos';
const MANIFEST_NAME = 'manifest.json';

/** `createSyncAccessHandle` は [Exposed=DedicatedWorker] なので、prototype はここでは見ない。 */
export function isOfflineVideoSupported(): boolean {
  return typeof navigator.storage?.getDirectory === 'function' && typeof Worker !== 'undefined';
}

function fileName(key: string): string {
  return `${key}.mp4`;
}

async function videosDir(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(DIR_NAME, { create: true });
}

function isNotFound(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'NotFoundError';
}

function copyBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

interface PendingCall {
  resolve: () => void;
  reject: (error: Error) => void;
}

interface DirectoryWithEntries {
  entries(): AsyncIterable<[string, FileSystemHandle]>;
}

/**
 * メインスレッドは manifest の読み書きと一覧・getFile だけを行う。
 * バイト列の write / truncate / remove は Worker に渡す。handle を開いたまま
 * getFile すると失敗するので、getFile の前に close を送る。
 */
export function createOpfsOfflineVideoStore(): OfflineVideoStore {
  let worker: Worker | null = null;
  let nextId = 1;
  const pending = new Map<number, PendingCall>();

  function failWorker(current: Worker, error: Error): void {
    current.onmessage = null;
    current.onerror = null;
    current.onmessageerror = null;
    current.terminate();
    if (worker === current) worker = null;
    const waiters = [...pending.values()];
    pending.clear();
    for (const waiter of waiters) waiter.reject(error);
  }

  function ensureWorker(): Worker {
    if (worker) return worker;
    const created = new Worker(new URL('./opfs-writer.worker.ts', import.meta.url), {
      type: 'module',
    });
    created.onmessage = (event: MessageEvent<WriterResponse>) => {
      const response = event.data;
      const waiter = pending.get(response.id);
      if (!waiter) return;
      pending.delete(response.id);
      if (response.ok) waiter.resolve();
      else waiter.reject(new Error(response.error));
    };
    created.onerror = (event) => {
      failWorker(created, new Error(event.message || 'offline video worker failed'));
    };
    created.onmessageerror = () => {
      failWorker(created, new Error('offline video worker message failed'));
    };
    worker = created;
    return created;
  }

  function send(command: WriterCommand, transfer?: Transferable[]): Promise<void> {
    const id = nextId;
    nextId += 1;
    const target = ensureWorker();
    const request: WriterRequest = { ...command, id };
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      if (transfer) target.postMessage(request, transfer);
      else target.postMessage(request);
    });
  }

  return {
    async readManifest() {
      let text: string;
      try {
        const dir = await videosDir();
        const handle = await dir.getFileHandle(MANIFEST_NAME);
        text = await (await handle.getFile()).text();
      } catch (error) {
        if (isNotFound(error)) return [];
        throw error;
      }
      try {
        const parsed: unknown = JSON.parse(text);
        return Array.isArray(parsed) ? (parsed as readonly OfflineVideoEntry[]) : [];
      } catch {
        return [];
      }
    },

    async writeManifest(entries) {
      const dir = await videosDir();
      const handle = await dir.getFileHandle(MANIFEST_NAME, { create: true });
      const writable = await handle.createWritable();
      try {
        await writable.write(JSON.stringify(entries));
        await writable.close();
      } catch (error) {
        try {
          await writable.abort();
        } catch {
          // close 済みの abort 失敗は無視し、書き込み側のエラーを返す。
        }
        throw error;
      }
    },

    async writeChunk(key, offset, bytes) {
      const buffer = copyBuffer(bytes);
      await send({ type: 'write', key, offset, bytes: buffer }, [buffer]);
    },

    async truncate(key) {
      await send({ type: 'truncate', key });
    },

    async removeFile(key) {
      await send({ type: 'remove', key });
    },

    async listFiles() {
      const dir = await videosDir();
      const keys: string[] = [];
      const suffix = '.mp4';
      for await (const [name] of (dir as unknown as DirectoryWithEntries).entries()) {
        if (!name.endsWith(suffix)) continue;
        keys.push(name.slice(0, -suffix.length));
      }
      return keys;
    },

    async getFile(key) {
      await send({ type: 'close', key });
      try {
        const dir = await videosDir();
        const handle = await dir.getFileHandle(fileName(key));
        return await handle.getFile();
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },
  };
}

let sharedStore: OfflineVideoStore | undefined;

/** プロセス内で 1 個だけ遅延生成する。呼び出し側はこれを共有する。 */
export function getOfflineVideoStore(): OfflineVideoStore {
  if (sharedStore === undefined) sharedStore = createOpfsOfflineVideoStore();
  return sharedStore;
}

let cachedOfflineVideoSupport: Promise<boolean> | undefined;

export function probeOfflineVideoSupport(): Promise<boolean> {
  if (cachedOfflineVideoSupport) return cachedOfflineVideoSupport;
  if (!isOfflineVideoSupported()) {
    cachedOfflineVideoSupport = Promise.resolve(false);
    return cachedOfflineVideoSupport;
  }
  cachedOfflineVideoSupport = probeSyncAccessInWorker();
  return cachedOfflineVideoSupport;
}

function probeSyncAccessInWorker(): Promise<boolean> {
  return new Promise((resolve) => {
    let created: Worker;
    try {
      created = new Worker(new URL('./opfs-writer.worker.ts', import.meta.url), { type: 'module' });
    } catch {
      resolve(false);
      return;
    }
    let settled = false;
    const finish = (supported: boolean): void => {
      if (settled) return;
      settled = true;
      created.onmessage = null;
      created.onerror = null;
      created.onmessageerror = null;
      created.terminate();
      resolve(supported);
    };
    created.onmessage = (event: MessageEvent<WriterResponse>) => {
      const response = event.data;
      finish(response.ok && response.supported === true);
    };
    created.onerror = () => finish(false);
    created.onmessageerror = () => finish(false);
    try {
      const request: WriterRequest = { id: 1, type: 'probe' };
      created.postMessage(request);
    } catch {
      finish(false);
    }
  });
}
