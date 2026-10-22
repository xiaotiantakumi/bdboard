/**
 * 端末に保存した動画の台帳 1 件 (bdboard-hipq.2)。
 * `origin` は後続チケットが 'auto' を書く。このチケットが作るのは 'manual' だけ。
 */
export interface OfflineVideoEntry {
  readonly key: string;
  readonly ticketId: string;
  readonly path: string;
  readonly size: number;
  readonly etag: string;
  readonly savedAt: number;
  readonly lastPlayedAt: number;
  readonly origin: 'manual' | 'auto';
  readonly bytesWritten: number;
  readonly complete: boolean;
}

/**
 * OPFS 実装 (次スコープ) とテスト用メモリ実装が共有する保存先。
 * `key` は `offlineVideoKey` の16進。ファイル名の `.mp4` は実装側が付ける。
 * `listFiles` は key(拡張子なし)を返す。
 */
export interface OfflineVideoStore {
  readManifest(): Promise<readonly OfflineVideoEntry[]>;
  writeManifest(entries: readonly OfflineVideoEntry[]): Promise<void>;
  writeChunk(key: string, offset: number, bytes: Uint8Array): Promise<void>;
  truncate(key: string): Promise<void>;
  removeFile(key: string): Promise<void>;
  listFiles(): Promise<readonly string[]>;
  getFile(key: string): Promise<File | null>;
}
