/**
 * bdboard-vgdr。チケットが指すプロジェクト内ファイルの中身 (raw) を返す。
 */

import type { Context } from 'hono';
import { resolveContainedLocalPath } from '../../application/local-files/resolve-contained-local-path.js';
import type { FileSystemPort } from '../../application/ports/file-system.js';
import {
  LOCAL_FILE_RANGE_CHUNK_BYTES,
  localFileUnrangedBodyLimitBytes,
  type LocalFileContentKind,
} from '../../domain/local-file-kinds.js';
import {
  formatContentRange,
  formatUnsatisfiedContentRange,
  parseByteRange,
} from './byte-range.js';
import { localFileErrorResponse } from './local-file-http-errors.js';

/**
 * アドレスバー直打ちは Sec-Fetch-Site: none でガードが 403 にする設計
 * （ビューア画面から `<img>` / `<video>` / fetch で読む）。
 * 巨大ファイルは全体を読まない（Range は 1 回 4 MiB まで）。
 */
export async function serveLocalFileRaw(
  c: Context,
  fs: Pick<FileSystemPort, 'realPath' | 'stat' | 'isDirectory' | 'readRangeBytes'>,
  rootPath: string,
): Promise<Response> {
  const requested = c.req.query('path');
  if (requested === undefined || requested === '') {
    return c.json({ error: 'path is required' }, 400);
  }

  const contained = await resolveContainedLocalPath(fs, rootPath, requested);
  if (!contained.ok) {
    const { status, body } = localFileErrorResponse(contained.reason);
    return c.json(body, status);
  }
  if (contained.isDirectory) {
    return c.json({ error: 'not a file' }, 400);
  }

  const range = parseByteRange(
    c.req.header('range'),
    contained.size,
    LOCAL_FILE_RANGE_CHUNK_BYTES,
  );
  if (range.kind === 'unsatisfiable') {
    return unsatisfiedRangeResponse(c, contained.size);
  }
  if (range.kind === 'range') {
    return serveByteRange(c, fs, contained, range.start, range.end);
  }
  return serveWholeFile(c, fs, contained);
}

function applyContentHeaders(c: Context, contentType: string, byteLength: number): void {
  c.header('Content-Type', contentType);
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Content-Security-Policy', "default-src 'none'; sandbox");
  c.header('Cache-Control', 'no-store');
  c.header('Accept-Ranges', 'bytes');
  c.header('Content-Length', String(byteLength));
}

function unsatisfiedRangeResponse(c: Context, size: number): Response {
  c.header('Content-Range', formatUnsatisfiedContentRange(size));
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Cache-Control', 'no-store');
  c.header('Accept-Ranges', 'bytes');
  return c.body(null, 416);
}

interface ResolvedFile {
  readonly realPath: string;
  readonly contentType: string;
  readonly size: number;
  readonly kind: LocalFileContentKind;
}

async function serveByteRange(
  c: Context,
  fs: Pick<FileSystemPort, 'readRangeBytes'>,
  contained: ResolvedFile,
  start: number,
  end: number,
): Promise<Response> {
  const bytes = await fs.readRangeBytes(contained.realPath, start, end - start + 1);
  if (bytes === undefined) {
    return c.json({ error: 'not found' }, 404);
  }
  if (bytes.length === 0) {
    return unsatisfiedRangeResponse(c, contained.size);
  }
  const actualEnd = start + bytes.length - 1;
  applyContentHeaders(c, contained.contentType, bytes.length);
  c.header('Content-Range', formatContentRange(start, actualEnd, contained.size));
  return c.body(new Uint8Array(bytes), 206);
}

async function serveWholeFile(
  c: Context,
  fs: Pick<FileSystemPort, 'readRangeBytes'>,
  contained: ResolvedFile,
): Promise<Response> {
  if (contained.size > localFileUnrangedBodyLimitBytes(contained.kind)) {
    return c.json({ error: 'file too large; request it with a Range header' }, 413);
  }
  const bytes = await fs.readRangeBytes(contained.realPath, 0, contained.size);
  if (bytes === undefined) {
    return c.json({ error: 'not found' }, 404);
  }
  applyContentHeaders(c, contained.contentType, bytes.length);
  return c.body(new Uint8Array(bytes), 200);
}
