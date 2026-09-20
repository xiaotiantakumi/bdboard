import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import type { BoardCache } from '../../application/ports/board-cache.js';
import type { AttachmentStoragePort } from '../../application/ports/attachment-storage.js';
import {
  ATTACHMENT_ALLOWED_MIME_TYPES,
  ATTACHMENT_BODY_MAX_BYTES,
  ATTACHMENT_MAX_COUNT_PER_TICKET,
  contentTypeForGeneratedFileName,
  decodeAttachmentImage,
  extensionForMimeType,
  isSafePathSegment,
  type AttachmentMimeType,
} from './attachment-validation.js';
import { parseJsonBody } from './request-body.js';
import { createWriteGuardMiddleware, type WriteGuardDeps } from './write-guard.js';

/**
 * チケット詳細の添付画像 API (bdboard-qw26)。
 *
 * 実機確認を human ゲートに載せるとき、ユーザーが画面/プレビューを見るだけで
 * 回答できるようにするための土台。エージェントが `curl` から呼べる形にするため、
 * アップロードは (multipart ではなく) JSON + base64 にしている: このアプリの
 * write-guard (bdboard-9rz) はクロスサイト書き込み対策として全ての書き込み系
 * リクエストの Content-Type を application/json に強制しており (write-guard.ts の
 * checkCsrf 参照)、multipart/form-data はそこで一律弾かれるため選べない。
 * chat-routes.ts の画像添付 (bdboard-3tw.104.24) と同じ形。
 */

/**
 * (projectKey, issueId) 単位で非同期処理を直列化する。
 *
 * Opus レビュー指摘 (bdboard-qw26): count() で件数を確認してから save()
 * する、という 2 段階の await の間に別のリクエストが割り込めると、
 * 同時並行アップロードが両方とも ATTACHMENT_MAX_COUNT_PER_TICKET の
 * チェックを通過してしまう TOCTOU がある (実際に 30 並列 POST で
 * 20 件上限を超えて 31 件保存されることを確認済み)。
 * 「件数チェック→保存」を同一チケットに対しては必ず1つずつ直列実行する
 * ことでこれを閉じる。プロセス内メモリの Map なので複数サーバープロセス
 * 間では効かないが、このアプリは1ポートにつき1プロセスの構成。
 */
const ticketUploadLocks = new Map<string, Promise<void>>();

function runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = ticketUploadLocks.get(key) ?? Promise.resolve();
  const result = previous.then(fn, fn);
  const settled = result.then(
    () => undefined,
    () => undefined,
  );
  ticketUploadLocks.set(key, settled);
  void settled.finally(() => {
    if (ticketUploadLocks.get(key) === settled) {
      ticketUploadLocks.delete(key);
    }
  });
  return result;
}

export interface AttachmentRoutesDeps {
  readonly cache: BoardCache;
  readonly storage: AttachmentStoragePort;
  /** トンネル経由の書き込みを開放するための依存。省略時は localhost 限定 (fail-closed)。 */
  readonly writeAccess?: WriteGuardDeps;
}

export interface AttachmentDto {
  readonly fileName: string;
  readonly url: string;
  readonly byteLength: number;
  readonly createdAt: string;
}

function findProjectRootPathForTicket(
  cache: BoardCache,
  ticketId: string,
): string | undefined {
  for (const entry of cache.listProjects()) {
    if (entry.tickets.some((ticket) => ticket.id === ticketId)) {
      return entry.project.rootPath;
    }
  }
  return undefined;
}

/**
 * プロジェクトを一意に表す、ファイルパスとして安全なキー。
 * rootPath の basename (人が見て分かるように) + rootPath 全体の sha1 先頭8桁
 * (一意性のため。別パスだが同名のプロジェクトが衝突しないように)。
 */
export function toProjectAttachmentKey(rootPath: string): string {
  const base = path
    .basename(rootPath)
    .replace(/[^A-Za-z0-9_-]/g, '-')
    .slice(0, 80);
  const hash = createHash('sha1').update(rootPath).digest('hex').slice(0, 8);
  return `${base.length > 0 ? base : 'project'}-${hash}`;
}

function toAttachmentDto(
  ticketId: string,
  attachment: { readonly fileName: string; readonly byteLength: number; readonly createdAt: Date },
): AttachmentDto {
  return {
    fileName: attachment.fileName,
    url: `/api/tickets/${encodeURIComponent(ticketId)}/attachments/${encodeURIComponent(attachment.fileName)}`,
    byteLength: attachment.byteLength,
    createdAt: attachment.createdAt.toISOString(),
  };
}

const uploadBodySchema = z.object({
  mimeType: z.enum(ATTACHMENT_ALLOWED_MIME_TYPES),
  data: z.string().min(1),
});

export function createAttachmentRoutes(deps: AttachmentRoutesDeps): Hono {
  const app = new Hono();

  // 書き込みガードはここ1箇所。このサブアプリは main.ts で app.route('/', ...) により
  // トップレベル app に "inner" (routes.ts) と兄弟として載る。inner 側の
  // app.use('*', createWriteGuardMiddleware(...)) はこちらのルートには効かないため
  // (chat-routes.ts と同じ理由)、独自に mount する。'/attachments' 単体は
  // '/attachments/*' にマッチしない (前方一致はサブパスのみ) ので両方登録する。
  //
  // 注意 (Opus レビュー指摘): main.ts はこのサブアプリを inner より「先」に
  // mount する (inner の GET /api/tickets/:id{.+} キャッチオールに横取りされ
  // ないようにするため)。つまり inner 側の app.use('*', createWriteGuardMiddleware
  // (...)) というブランケットガードの「安全網」もこのサブアプリには掛からない。
  // 今後このファイルに書き込み系ルートを追加するときは、必ず対応する
  // path pattern を上の2行と同様に writeGuard へ明示的に use() すること
  // (でないと無認証で書き込み可能なエンドポイントが生まれる)。
  const writeGuard = createWriteGuardMiddleware(deps.writeAccess ?? {});
  app.use('/api/tickets/:id/attachments', writeGuard);
  app.use('/api/tickets/:id/attachments/*', writeGuard);

  const uploadBodyLimit = bodyLimit({
    maxSize: ATTACHMENT_BODY_MAX_BYTES,
    onError: (c) => c.json({ error: 'request body too large' }, 413),
  });
  app.use('/api/tickets/:id/attachments', uploadBodyLimit);

  app.get('/api/tickets/:id/attachments', async (c) => {
    const id = c.req.param('id');
    if (!isSafePathSegment(id)) {
      return c.json({ error: 'invalid ticket id' }, 400);
    }
    const rootPath = findProjectRootPathForTicket(deps.cache, id);
    if (rootPath === undefined) {
      return c.json({ error: 'ticket not found', id }, 404);
    }
    const projectKey = toProjectAttachmentKey(rootPath);
    const attachments = await deps.storage.list(projectKey, id);
    return c.json({ attachments: attachments.map((entry) => toAttachmentDto(id, entry)) });
  });

  app.post('/api/tickets/:id/attachments', async (c) => {
    const id = c.req.param('id');
    if (!isSafePathSegment(id)) {
      return c.json({ error: 'invalid ticket id' }, 400);
    }
    const rootPath = findProjectRootPathForTicket(deps.cache, id);
    if (rootPath === undefined) {
      return c.json({ error: 'ticket not found', id }, 404);
    }

    const parsed = await parseJsonBody(c, uploadBodySchema);
    if (!parsed.ok) return parsed.response;

    const mimeType = parsed.data.mimeType as AttachmentMimeType;
    const decoded = decodeAttachmentImage(mimeType, parsed.data.data);
    if (decoded === undefined) {
      return c.json({ error: 'invalid or unsupported image data' }, 400);
    }

    const projectKey = toProjectAttachmentKey(rootPath);
    const outcome = await runExclusive(`${projectKey}/${id}`, async () => {
      const existingCount = await deps.storage.count(projectKey, id);
      if (existingCount >= ATTACHMENT_MAX_COUNT_PER_TICKET) {
        return { ok: false as const };
      }
      const stored = await deps.storage.save(
        projectKey,
        id,
        extensionForMimeType(mimeType),
        decoded,
      );
      return { ok: true as const, stored };
    });

    if (!outcome.ok) {
      return c.json(
        {
          error: `attachment limit reached (max ${ATTACHMENT_MAX_COUNT_PER_TICKET} per ticket)`,
        },
        409,
      );
    }

    return c.json({ attachment: toAttachmentDto(id, outcome.stored) }, 201);
  });

  app.get('/api/tickets/:id/attachments/:fileName', async (c) => {
    const id = c.req.param('id');
    if (!isSafePathSegment(id)) {
      return c.json({ error: 'invalid ticket id' }, 400);
    }
    const fileName = c.req.param('fileName');
    const contentType = contentTypeForGeneratedFileName(fileName);
    if (contentType === undefined) {
      return c.json({ error: 'invalid attachment file name' }, 400);
    }
    const rootPath = findProjectRootPathForTicket(deps.cache, id);
    if (rootPath === undefined) {
      return c.json({ error: 'ticket not found', id }, 404);
    }
    const projectKey = toProjectAttachmentKey(rootPath);
    const data = await deps.storage.read(projectKey, id, fileName);
    if (data === undefined) {
      return c.json({ error: 'attachment not found' }, 404);
    }
    c.header('Content-Type', contentType);
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Content-Disposition', 'inline');
    c.header('Cache-Control', 'private, max-age=31536000, immutable');
    return c.body(new Uint8Array(data));
  });

  // DELETE も上の write-guard (`/api/tickets/:id/attachments/*`) の対象になる。
  // v1 では upload と同じ権限 (write-guard を通る者は誰でも削除可) にとどめる
  // (bdboard-ij1h)。実体は unlink せず、AttachmentStoragePort.delete() がゴミ箱へ
  // 退避する (誤削除からの復旧手段を残すため)。上限カウントと同じ per-(projectKey,
  // issueId) ロックに含めるのは、上限ちょうどの状態で削除とアップロードが並行しても
  // 件数上限を破らないようにするため (count/save/delete を同一チケットに対しては
  // 直列実行する)。
  app.delete('/api/tickets/:id/attachments/:fileName', async (c) => {
    const id = c.req.param('id');
    if (!isSafePathSegment(id)) {
      return c.json({ error: 'invalid ticket id' }, 400);
    }
    const fileName = c.req.param('fileName');
    // GET と同じ判定 (isGeneratedAttachmentFileName 相当) を再利用する。
    if (contentTypeForGeneratedFileName(fileName) === undefined) {
      return c.json({ error: 'invalid attachment file name' }, 400);
    }
    const rootPath = findProjectRootPathForTicket(deps.cache, id);
    if (rootPath === undefined) {
      return c.json({ error: 'ticket not found', id }, 404);
    }
    const projectKey = toProjectAttachmentKey(rootPath);
    const deleted = await runExclusive(`${projectKey}/${id}`, () =>
      deps.storage.delete(projectKey, id, fileName),
    );
    if (!deleted) {
      return c.json({ error: 'attachment not found' }, 404);
    }
    return c.json({ ok: true });
  });

  return app;
}
