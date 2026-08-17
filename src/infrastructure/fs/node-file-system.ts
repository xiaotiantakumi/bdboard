import { open, readdir, readFile, realpath, stat as fsStat } from 'node:fs/promises';
import type { DirEntry, FileStat, FileSystemPort } from '../../application/ports/file-system.js';

export class NodeFileSystem implements FileSystemPort {
  async readDir(dirPath: string): Promise<readonly DirEntry[]> {
    const entries = await readdir(dirPath, { withFileTypes: true });
    return entries.map((entry) => ({
      name: entry.name,
      isDirectory: entry.isDirectory(),
      isSymbolicLink: entry.isSymbolicLink(),
    }));
  }

  async isDirectory(dirPath: string): Promise<boolean> {
    try {
      const fileStat = await fsStat(dirPath);
      return fileStat.isDirectory();
    } catch {
      return false;
    }
  }

  async realPath(dirPath: string): Promise<string> {
    try {
      return await realpath(dirPath);
    } catch {
      return dirPath;
    }
  }

  async stat(filePath: string): Promise<FileStat | undefined> {
    try {
      const fileStat = await fsStat(filePath);
      return { mtimeMs: fileStat.mtimeMs, size: fileStat.size };
    } catch {
      return undefined;
    }
  }

  async readFile(filePath: string): Promise<string | undefined> {
    try {
      return await readFile(filePath, 'utf8');
    } catch {
      return undefined;
    }
  }

  async readRange(filePath: string, start: number, length: number): Promise<string | undefined> {
    const bytes = await this.readRangeBytes(filePath, start, length);
    if (bytes === undefined) {
      return undefined;
    }
    return bytes.toString('utf8');
  }

  async readRangeBytes(
    filePath: string,
    start: number,
    length: number,
  ): Promise<Buffer | undefined> {
    if (length <= 0) {
      return Buffer.alloc(0);
    }

    const readStart = start < 0 ? 0 : start;
    let handle: Awaited<ReturnType<typeof open>> | undefined;

    try {
      handle = await open(filePath, 'r');
      const buffer = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(buffer, 0, length, readStart);
      return buffer.subarray(0, bytesRead);
    } catch {
      return undefined;
    } finally {
      if (handle !== undefined) {
        try {
          await handle.close();
        } catch {
          // Swallow close errors; readRangeBytes must not throw.
        }
      }
    }
  }
}
