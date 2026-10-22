/**
 * OPFS へ動画バイトを書く専用 module Worker (bdboard-hipq.2)。
 * `createSyncAccessHandle` は Worker からしか使えず、同一ファイルの handle は
 * 同時に 1 つしか開けない。key ごとに Map で使い回し、メッセージは 1 本の列で処理する。
 *
 * web/tsconfig の lib は DOM のままにする。`DedicatedWorkerGlobalScope` と
 * `FileSystemSyncAccessHandle` はこの TypeScript では lib.webworker 側にしか無いので、
 * ここで使う面だけ宣言する。
 */

interface FileSystemSyncAccessHandle {
  write(buffer: BufferSource, options?: { at?: number }): number;
  truncate(newSize: number): void;
  getSize(): number;
  flush(): void;
  close(): void;
}

/** DOM の FileSystemFileHandle には createSyncAccessHandle が無い。 */
interface SyncAccessFileHandle {
  createSyncAccessHandle(): Promise<FileSystemSyncAccessHandle>;
}

interface DedicatedWorkerGlobalScope {
  onmessage: ((this: DedicatedWorkerGlobalScope, ev: MessageEvent<WriterRequest>) => void) | null;
  postMessage(message: WriterResponse): void;
}

const DIR_NAME = 'offline-videos';

export type WriterCommand =
  | { type: 'write'; key: string; offset: number; bytes: ArrayBuffer }
  | { type: 'truncate'; key: string }
  | { type: 'close'; key: string }
  | { type: 'remove'; key: string }
  | { type: 'probe' };

export type WriterRequest = WriterCommand & { id: number };

export type WriterResponse =
  | { id: number; ok: true; supported?: boolean }
  | { id: number; ok: false; error: string };

const scope = self as unknown as DedicatedWorkerGlobalScope;
const handles = new Map<string, FileSystemSyncAccessHandle>();

function fileName(key: string): string {
  return `${key}.mp4`;
}

async function videosDir(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(DIR_NAME, { create: true });
}

async function handleFor(key: string): Promise<FileSystemSyncAccessHandle> {
  const existing = handles.get(key);
  if (existing) return existing;
  const dir = await videosDir();
  const file = await dir.getFileHandle(fileName(key), { create: true });
  const handle = await (file as unknown as SyncAccessFileHandle).createSyncAccessHandle();
  handles.set(key, handle);
  return handle;
}

/**
 * 実行時の write / flush / truncate / close は Promise を返す実装がある。
 * 型は同期だが、await しておけば同期・非同期のどちらでも完了を待ってから応答できる。
 */
async function closeHandle(key: string): Promise<void> {
  const handle = handles.get(key);
  if (!handle) return;
  await handle.close();
  handles.delete(key);
}

function isNotFound(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'NotFoundError';
}

async function run(message: WriterRequest): Promise<void> {
  switch (message.type) {
    case 'write': {
      const handle = await handleFor(message.key);
      // 途中でファイルが消えた (掃除・全削除・別ウィンドウ) とき、新しい空ファイルの途中に
      // 書くと先頭が穴のまま complete になる。足りないときは書かずに失敗させる。
      if (message.offset > (await handle.getSize())) {
        throw new Error('offline video file is shorter than the write offset');
      }
      const written = await handle.write(new Uint8Array(message.bytes), { at: message.offset });
      if (written !== message.bytes.byteLength) {
        throw new Error('offline video write was short');
      }
      await handle.flush();
      return;
    }
    case 'truncate': {
      const handle = await handleFor(message.key);
      await handle.truncate(0);
      await handle.flush();
      return;
    }
    case 'close': {
      await closeHandle(message.key);
      return;
    }
    case 'remove': {
      await closeHandle(message.key);
      const dir = await videosDir();
      try {
        await dir.removeEntry(fileName(message.key));
      } catch (error) {
        // 無いファイルを消すのは目的を満たしている。台帳だけ残ったキーも消せる。
        if (!isNotFound(error)) throw error;
      }
      return;
    }
    case 'probe':
      return;
    default: {
      const unreachable: never = message;
      throw new Error(`unknown offline video worker message: ${JSON.stringify(unreachable)}`);
    }
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

let queue: Promise<void> = Promise.resolve();

scope.onmessage = (event) => {
  const message = event.data;
  queue = queue
    .then(async () => {
      try {
        await run(message);
        if (message.type === 'probe') {
          scope.postMessage({
            id: message.id,
            ok: true,
            supported:
              typeof FileSystemFileHandle !== 'undefined' &&
              'createSyncAccessHandle' in FileSystemFileHandle.prototype,
          });
          return;
        }
        scope.postMessage({ id: message.id, ok: true });
      } catch (error) {
        scope.postMessage({ id: message.id, ok: false, error: errorText(error) });
      }
    })
    .catch(() => {
      // 応答自体が失敗しても次のメッセージは止めない。
    });
};
