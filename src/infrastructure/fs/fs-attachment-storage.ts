import fs from 'node:fs/promises';
import type { Stats } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type {
  AttachmentStoragePort,
  StoredAttachment,
} from '../../application/ports/attachment-storage.js';

interface FileEntry {
  readonly fileName: string;
  readonly stat: Stats;
}

/**
 * ファイルシステム版の添付画像ストア (bdboard-qw26)。
 *
 * 呼び出し側 (interface 層の attachment-routes.ts) が projectKey / issueId /
 * fileName を allowlist 正規表現で検証済みという前提だが、実装側でも
 * path.resolve 後に baseDir 配下であることを再確認する (defense in depth:
 * 呼び出し側の検証漏れが将来入っても、ここで二重に弾ける)。
 */
export function createFsAttachmentStorage(baseDir: string): AttachmentStoragePort {
  const resolvedBaseDir = path.resolve(baseDir);

  function issueDir(projectKey: string, issueId: string): string {
    const dir = path.resolve(resolvedBaseDir, projectKey, issueId);
    const withSep = resolvedBaseDir.endsWith(path.sep)
      ? resolvedBaseDir
      : resolvedBaseDir + path.sep;
    // projectKey/issueId は非空文字列なので、正当な入力で dir が resolvedBaseDir と
    // 完全一致することはない。以前あった `dir !== resolvedBaseDir &&` の除外は、
    // このチェックがまさに防ぐべき「呼び出し側の検証をすり抜けた '..' 等」を
    // 通してしまう穴だったため削除した (bdboard-qw26 Opus レビュー指摘)。
    if (!dir.startsWith(withSep)) {
      throw new Error(`attachment path escapes base dir: ${projectKey}/${issueId}`);
    }
    return dir;
  }

  function filePath(projectKey: string, issueId: string, fileName: string): string {
    const dir = issueDir(projectKey, issueId);
    const target = path.resolve(dir, fileName);
    const dirWithSep = dir.endsWith(path.sep) ? dir : dir + path.sep;
    if (!target.startsWith(dirWithSep)) {
      throw new Error(`attachment file path escapes issue dir: ${fileName}`);
    }
    return target;
  }

  /**
   * ゴミ箱側の issue ディレクトリ (bdboard-ij1h)。baseDir 直下の `.trash/` に
   * projectKey/issueId と同じ形でぶら下げる。list/count/read はこの配下を
   * 一切辿らない (issueDir() 経由でしか到達できず、そちらは `.trash` という
   * セグメントを通らない) ので、削除済みファイルは一覧・取得・件数上限の
   * カウントから自然に除外される。
   */
  function trashIssueDir(projectKey: string, issueId: string): string {
    const dir = path.resolve(resolvedBaseDir, '.trash', projectKey, issueId);
    const withSep = resolvedBaseDir.endsWith(path.sep)
      ? resolvedBaseDir
      : resolvedBaseDir + path.sep;
    if (!dir.startsWith(withSep)) {
      throw new Error(`attachment trash path escapes base dir: ${projectKey}/${issueId}`);
    }
    return dir;
  }

  function trashFilePath(projectKey: string, issueId: string, fileName: string): string {
    const dir = trashIssueDir(projectKey, issueId);
    const target = path.resolve(dir, fileName);
    const dirWithSep = dir.endsWith(path.sep) ? dir : dir + path.sep;
    if (!target.startsWith(dirWithSep)) {
      throw new Error(`attachment trash file path escapes trash issue dir: ${fileName}`);
    }
    return target;
  }

  async function listEntries(
    projectKey: string,
    issueId: string,
  ): Promise<readonly FileEntry[]> {
    const dir = issueDir(projectKey, issueId);
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const entries = await Promise.all(
      names.map(async (name): Promise<FileEntry | undefined> => {
        try {
          const stat = await fs.stat(path.join(dir, name));
          return { fileName: name, stat };
        } catch {
          return undefined;
        }
      }),
    );
    return entries.filter(
      (entry): entry is FileEntry => entry !== undefined && entry.stat.isFile(),
    );
  }

  return {
    async count(projectKey, issueId) {
      const entries = await listEntries(projectKey, issueId);
      return entries.length;
    },

    async save(projectKey, issueId, extension, data) {
      const dir = issueDir(projectKey, issueId);
      await fs.mkdir(dir, { recursive: true });

      // ファイル名はサーバーが採番する (bdboard-qw26 方針: 元のファイル名は信用しない)。
      // 衝突はほぼ考えられないが、念のためリトライする。
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const fileName = `${Date.now()}-${randomBytes(8).toString('hex')}.${extension}`;
        const target = filePath(projectKey, issueId, fileName);
        try {
          await fs.writeFile(target, data, { flag: 'wx' });
          const stat = await fs.stat(target);
          return { fileName, byteLength: stat.size, createdAt: stat.mtime };
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue;
          throw err;
        }
      }
      throw new Error('failed to allocate a unique attachment file name');
    },

    async list(projectKey, issueId) {
      const entries = await listEntries(projectKey, issueId);
      const attachments: StoredAttachment[] = entries.map((entry) => ({
        fileName: entry.fileName,
        byteLength: entry.stat.size,
        createdAt: entry.stat.mtime,
      }));
      attachments.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      return attachments;
    },

    async read(projectKey, issueId, fileName) {
      const target = filePath(projectKey, issueId, fileName);
      try {
        return await fs.readFile(target);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw err;
      }
    },

    async delete(projectKey, issueId, fileName) {
      const source = filePath(projectKey, issueId, fileName);
      const destDir = trashIssueDir(projectKey, issueId);
      const dest = trashFilePath(projectKey, issueId, fileName);
      await fs.mkdir(destDir, { recursive: true });
      try {
        // fileName はサーバー採番 (epochMs + 16桁hexランダム) で衝突は事実上
        // 起きないため、同名の既存ゴミ箱エントリを上書きする心配はしていない。
        await fs.rename(source, dest);
        return true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw err;
      }
    },
  };
}
