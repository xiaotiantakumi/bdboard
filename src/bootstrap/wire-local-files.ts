/**
 * bdboard-vgdr: チケット本文が指すプロジェクト内ファイルを見る API (ローカル直、または認可済みトンネルセッション) の
 * ルーターを組み立てる。mount 順 (`inner` の catch-all より前) は mount-routes.ts の責務。
 */
import type { Hono } from 'hono';
import type { BoardCache } from '../application/ports/board-cache.js';
import type { CommentReader } from '../application/ports/comment-reader.js';
import type { FileSystemPort } from '../application/ports/file-system.js';
import { createLocalFileRoutes } from '../interface/http/local-file-routes.js';
import type { WriteGuardDeps } from '../interface/http/write-guard.js';

export interface WireLocalFilesDeps {
  readonly cache: BoardCache;
  readonly fsPort: FileSystemPort;
  readonly commentReader?: CommentReader;
  readonly writeAccess: WriteGuardDeps;
}

export function wireLocalFiles(deps: WireLocalFilesDeps): Hono {
  return createLocalFileRoutes({
    cache: deps.cache,
    fs: deps.fsPort,
    commentReader: deps.commentReader,
    writeAccess: deps.writeAccess,
  });
}
