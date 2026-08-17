export interface DirEntry {
  readonly name: string;
  readonly isDirectory: boolean;
  readonly isSymbolicLink: boolean;
}

export interface FileStat {
  readonly mtimeMs: number;
  readonly size: number;
}

export interface FileSystemPort {
  /** Enumerate directory contents. May throw if unreadable (callers swallow it). */
  readDir(path: string): Promise<readonly DirEntry[]>;
  /** true if the path exists and is a directory */
  isDirectory(path: string): Promise<boolean>;
  /** Symlink-resolved real path. If it cannot be resolved, return the input unchanged. */
  realPath(path: string): Promise<string>;
  /** 存在しない/読めない場合は undefined を返す(例外を投げない) */
  stat(path: string): Promise<FileStat | undefined>;
  /** 存在しない/読めない場合は undefined を返す(例外を投げない) */
  readFile(path: string): Promise<string | undefined>;
  /** [start, start+length) のバイトを UTF-8 として読む。読めなければ undefined。
   *  ファイル全体を読み込む実装にしてはいけない(巨大ファイル対策) */
  readRange(path: string, start: number, length: number): Promise<string | undefined>;
  /** [start, start+length) の生バイトを読む。読めなければ undefined。
   *  ファイル全体を読み込む実装にしてはいけない(巨大ファイル対策) */
  readRangeBytes(path: string, start: number, length: number): Promise<Buffer | undefined>;
}
