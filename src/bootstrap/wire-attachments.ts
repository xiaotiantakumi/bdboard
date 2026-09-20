/**
 * bdboard-sso1.14: src/main.ts (composition root) から添付ファイル領域の配線を
 * 切り出したもの (move only, 挙動変更ゼロ)。
 *
 * 保存先ディレクトリの解決 (BDBOARD_ATTACHMENTS_DIR での上書きを含む) と
 * ルーターの組み立てだけを行う。mount 順 (`inner` の catch-all より前) は
 * mount-routes.ts 側の責務であり、ここでは持たない。
 */
import type { Hono } from 'hono';
import type { BoardCache } from '../application/ports/board-cache.js';
import type { WriteGuardDeps } from '../interface/http/write-guard.js';
import { createAttachmentRoutes } from '../interface/http/attachment-routes.js';
import { createFsAttachmentStorage } from '../infrastructure/fs/fs-attachment-storage.js';
import { resolveAttachmentsDir } from '../infrastructure/fs/resolve-attachments-dir.js';

export interface WireAttachmentsDeps {
  readonly repoRoot: string;
  readonly env: NodeJS.ProcessEnv;
  readonly cache: BoardCache;
  readonly writeAccess: WriteGuardDeps;
  readonly log?: (message: string) => void;
}

export function wireAttachments(deps: WireAttachmentsDeps): { attachmentsRouter: Hono } {
  const log = deps.log ?? console.log;
  const attachmentsDir = resolveAttachmentsDir(deps.repoRoot, deps.env);
  const attachmentStorage = createFsAttachmentStorage(attachmentsDir);

  const attachmentsRouter = createAttachmentRoutes({
    cache: deps.cache,
    storage: attachmentStorage,
    writeAccess: deps.writeAccess,
  });

  log(`Ticket attachments: storing under ${attachmentsDir}`);

  return { attachmentsRouter };
}
