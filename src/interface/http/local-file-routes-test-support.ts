import path from 'node:path';
import type { Hono } from 'hono';
import type { BoardCache } from '../../application/ports/board-cache.js';
import type { CommentReader } from '../../application/ports/comment-reader.js';
import type { DirEntry, FileSystemPort } from '../../application/ports/file-system.js';
import { makeTicket } from '../../domain/test-support.js';
import type { Ticket } from '../../domain/ticket.js';

export const LOCAL_FILES_TEST_ROOT = '/projects/動画生成';
export const LOCAL_FILES_TEST_TICKET_ID = 'video-1';

/** Map ベースの偽 FS。realPath は恒等。addFile は親フォルダも全部作る。 */
export interface FakeLocalFs extends Pick<
  FileSystemPort,
  'realPath' | 'stat' | 'isDirectory' | 'readDir' | 'readRangeBytes'
> {
  addFile(relativePath: string, content: string | Buffer): void;
  addDirectory(relativePath: string): void;
  readonly readRangeCalls: Array<{ path: string; start: number; length: number }>;
}

export function createFakeLocalFs(root: string = LOCAL_FILES_TEST_ROOT): FakeLocalFs {
  const files = new Map<string, Buffer>();
  const directories = new Set<string>([root]);
  const readRangeCalls: FakeLocalFs['readRangeCalls'] = [];

  const addDirectoryChain = (absolute: string): void => {
    let current = absolute;
    directories.add(current);
    while (current !== root) {
      const parent = path.dirname(current);
      if (parent === current) return;
      if (parent !== root && !parent.startsWith(`${root}${path.sep}`)) return;
      current = parent;
      directories.add(current);
    }
  };

  return {
    readRangeCalls,
    addFile(relativePath, content) {
      const absolute = path.join(root, relativePath);
      // Buffer.from の overload は string | Buffer を一度に受けない。
      const bytes = typeof content === 'string' ? Buffer.from(content) : Buffer.from(content);
      files.set(absolute, bytes);
      addDirectoryChain(path.dirname(absolute));
    },
    addDirectory(relativePath) {
      addDirectoryChain(path.join(root, relativePath));
    },
    realPath(targetPath) {
      return Promise.resolve(targetPath);
    },
    stat(targetPath) {
      const buf = files.get(targetPath);
      if (buf !== undefined) return Promise.resolve({ mtimeMs: 0, size: buf.length });
      if (directories.has(targetPath)) return Promise.resolve({ mtimeMs: 0, size: 0 });
      return Promise.resolve(undefined);
    },
    isDirectory(targetPath) {
      return Promise.resolve(directories.has(targetPath));
    },
    readDir(targetPath) {
      if (!directories.has(targetPath)) return Promise.reject(new Error('ENOENT'));
      const byName = new Map<string, DirEntry>();
      for (const dir of directories) {
        if (path.dirname(dir) !== targetPath) continue;
        const name = path.basename(dir);
        byName.set(name, { name, isDirectory: true, isSymbolicLink: false });
      }
      for (const filePath of files.keys()) {
        if (path.dirname(filePath) !== targetPath) continue;
        const name = path.basename(filePath);
        if (byName.has(name)) continue;
        byName.set(name, { name, isDirectory: false, isSymbolicLink: false });
      }
      return Promise.resolve([...byName.values()]);
    },
    readRangeBytes(targetPath, start, length) {
      readRangeCalls.push({ path: targetPath, start, length });
      const buf = files.get(targetPath);
      if (buf === undefined) return Promise.resolve(undefined);
      return Promise.resolve(Buffer.from(buf.subarray(start, start + length)));
    },
  };
}

export function createFakeLocalFilesCache(
  ticket: Partial<Ticket>,
  root: string = LOCAL_FILES_TEST_ROOT,
): Pick<BoardCache, 'listProjects'> {
  return {
    listProjects: () => [
      {
        project: {
          id: 'video',
          name: 'video',
          rootPath: root,
          prefixes: ['video'],
          aliasPaths: [],
        },
        tickets: [
          makeTicket({
            id: LOCAL_FILES_TEST_TICKET_ID,
            projectId: 'video',
            ...ticket,
          }),
        ],
        fingerprint: 'fp-video',
        fetchedAt: new Date('2026-10-14T00:00:00.000Z'),
      },
    ],
  };
}

export function createFakeCommentReader(texts: readonly string[] | Error): CommentReader {
  return {
    listComments(_rootPath, issueId) {
      if (texts instanceof Error) return Promise.reject(texts);
      return Promise.resolve(
        texts.map((text, index) => ({
          id: `c${index}`,
          issueId,
          author: 'example-user',
          text,
          createdAt: new Date(0),
        })),
      );
    },
  };
}

/** ローカル直アクセスとして app.request を呼ぶ (attachment-routes.test.ts と同じ env の形)。 */
export function requestLocal(
  app: Hono,
  url: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return Promise.resolve(
    app.request(
      url,
      { headers: { Host: 'localhost:8787', ...headers } },
      { incoming: { socket: { remoteAddress: '127.0.0.1', localPort: 8787 } } },
    ),
  );
}
