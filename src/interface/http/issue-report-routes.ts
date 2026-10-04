import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import type { IssueDraftService } from '../../application/issue-report/issue-draft-service.js';
import {
  ISSUE_DRAFT_DISMISS_REASON_MAX_CHARS,
  ISSUE_DRAFT_MAX_IMAGES,
  isDraftId,
} from '../../domain/issue-draft.js';
import {
  ATTACHMENT_ALLOWED_MIME_TYPES,
  ATTACHMENT_BODY_MAX_BYTES,
  contentTypeForGeneratedFileName,
  decodeAttachmentImage,
  extensionForMimeType,
} from './attachment-validation.js';
import { ISSUE_DRAFTS_PATH, toImageDto, toSummaryDto } from './issue-report-dto.js';
import { parseJsonBody } from './request-body.js';
import {
  createPrivilegedApiGuardMiddleware,
  createWriteGuardMiddleware,
  type WriteGuardDeps,
} from './write-guard.js';

/**
 * 不具合報告の下書き API (bdboard-4y8q.1、docs/ISSUE-REPORTING.md 3節)。
 *
 * 認可は経路ごとに違う:
 *   - 受け取り (POST drafts) と画像の追加 (POST drafts/:id/images): ローカル直アクセスのみ。
 *     createPrivilegedApiGuardMiddleware にトンネル用の依存を渡さないことで、
 *     「強パスワード + セッション Cookie のトンネル」でも通さない (設計 3節の1行)。
 *   - 一覧・取得・画像の取得 (GET): ほかの読み取り API と同じ。トンネルではトンネルの
 *     認証 (Basic 認証) を通れば読める。
 *   - 見送り (PATCH dismiss): 通常の write-guard (ローカル直、または強パスワード + セッション)。
 *
 * このルーターは何も外へ送らない。投稿 (bdboard-4y8q.4) は別の経路。
 */

/** 受け取り POST の上限。長いエラー文は受けてから先頭と末尾だけ残す (捨てずに切り詰める)。 */
export const ISSUE_REPORT_BODY_MAX_BYTES = 1024 * 1024;
const DISMISS_BODY_MAX_BYTES = 16 * 1024;

const versionString = z.string().max(100);

const receiveBodySchema = z.object({
  kind: z.enum(['A', 'B', 'C']),
  catalogSlug: z.string().min(1).max(200).optional(),
  source: z.string().min(1).max(200).optional(),
  symptom: z.string().optional(),
  cause: z.string().optional(),
  prevention: z.string().optional(),
  errorText: z.string().optional(),
  agentNote: z.string().optional(),
  envInfo: z
    .object({
      bdboardVersion: versionString.optional(),
      harnessVersion: versionString.optional(),
      os: versionString.optional(),
      nodeVersion: versionString.optional(),
      bdVersion: versionString.optional(),
      ghVersion: versionString.optional(),
    })
    .optional(),
  project: z.object({ name: z.string().max(200), path: z.string().max(1000) }).optional(),
  sourceTicketRef: z.string().max(200).optional(),
});

const dismissBodySchema = z.object({
  reason: z.string().trim().min(1).max(ISSUE_DRAFT_DISMISS_REASON_MAX_CHARS),
});

const imageBodySchema = z.object({
  mimeType: z.enum(ATTACHMENT_ALLOWED_MIME_TYPES),
  data: z.string().min(1),
});

export interface IssueReportRoutesDeps {
  readonly service: IssueDraftService;
  /** 見送り (PATCH) にだけ効く。省略時はローカル直アクセス限定 (fail-closed)。 */
  readonly writeAccess?: WriteGuardDeps;
}

function limitBody(maxSize: number) {
  return bodyLimit({ maxSize, onError: (c) => c.json({ error: 'request body too large' }, 413) });
}

export function createIssueReportRoutes(deps: IssueReportRoutesDeps): Hono {
  const app = new Hono();
  const { service } = deps;

  // このサブアプリは inner (routes.ts) と兄弟として mount されるので、inner のブランケットの
  // 書き込みガードに頼らず、自分で全メソッドの書き込み系に掛ける (attachment-routes.ts と同じ理由)。
  app.use('/api/issue-reports/*', createWriteGuardMiddleware(deps.writeAccess ?? {}));

  // ローカル直アクセスだけ。トンネル用の依存を渡さないので、トンネルセッションがあっても 403。
  const localOnlyGuard = createPrivilegedApiGuardMiddleware({});

  app.post(ISSUE_DRAFTS_PATH, localOnlyGuard, limitBody(ISSUE_REPORT_BODY_MAX_BYTES), async (c) => {
    const parsed = await parseJsonBody(c, receiveBodySchema);
    if (!parsed.ok) return parsed.response;

    const result = await service.receive(parsed.data);
    if (!result.ok) {
      return c.json(
        { error: 'catalogSlug (kind A) or source (kind B/C) is required to fingerprint the report' },
        400,
      );
    }
    return c.json(
      { outcome: result.outcome, draft: toSummaryDto(result.draft) },
      result.outcome === 'created' ? 201 : 200,
    );
  });

  app.get(ISSUE_DRAFTS_PATH, async (c) => {
    const drafts = await service.list();
    return c.json({ drafts: drafts.map(toSummaryDto) });
  });

  app.get(`${ISSUE_DRAFTS_PATH}/:id`, async (c) => {
    const id = c.req.param('id');
    if (!isDraftId(id)) return c.json({ error: 'invalid draft id' }, 400);
    const draft = await service.get(id);
    if (draft === undefined) return c.json({ error: 'draft not found', id }, 404);
    const images = (await service.listImages(id)) ?? [];
    return c.json({ draft, images: images.map((image) => toImageDto(id, image)) });
  });

  app.patch(`${ISSUE_DRAFTS_PATH}/:id/dismiss`, limitBody(DISMISS_BODY_MAX_BYTES), async (c) => {
    const id = c.req.param('id');
    if (!isDraftId(id)) return c.json({ error: 'invalid draft id' }, 400);
    const parsed = await parseJsonBody(c, dismissBodySchema);
    if (!parsed.ok) return parsed.response;

    const result = await service.dismiss(id, parsed.data.reason);
    if (result.ok) return c.json({ draft: toSummaryDto(result.draft) });
    if (result.reason === 'not-found') return c.json({ error: 'draft not found', id }, 404);
    return c.json({ error: 'draft is not pending', status: result.status }, 409);
  });

  app.post(`${ISSUE_DRAFTS_PATH}/:id/images`, localOnlyGuard, limitBody(ATTACHMENT_BODY_MAX_BYTES), async (c) => {
    const id = c.req.param('id');
    if (!isDraftId(id)) return c.json({ error: 'invalid draft id' }, 400);
    // 10MB 級のデコードをする前に、下書きの存在だけ先に確かめる。
    if ((await service.get(id)) === undefined) return c.json({ error: 'draft not found', id }, 404);

    const parsed = await parseJsonBody(c, imageBodySchema);
    if (!parsed.ok) return parsed.response;

    // 添付画像と同じ検査 (base64 の厳密デコード・マジックバイト・1 枚 10MB)。
    const { mimeType } = parsed.data;
    const decoded = decodeAttachmentImage(mimeType, parsed.data.data);
    if (decoded === undefined) return c.json({ error: 'invalid or unsupported image data' }, 400);

    const result = await service.addImage(id, extensionForMimeType(mimeType), decoded);
    if (!result.ok) {
      return result.reason === 'not-found'
        ? c.json({ error: 'draft not found', id }, 404)
        : c.json({ error: `image limit reached (max ${ISSUE_DRAFT_MAX_IMAGES} per draft)` }, 409);
    }
    return c.json({ image: toImageDto(id, result.image) }, 201);
  });

  app.get(`${ISSUE_DRAFTS_PATH}/:id/images/:fileName`, async (c) => {
    const id = c.req.param('id');
    if (!isDraftId(id)) return c.json({ error: 'invalid draft id' }, 400);
    const fileName = c.req.param('fileName');
    // Content-Type は生成ファイル名の拡張子からだけ決める (クライアントの主張を信用しない)。
    const contentType = contentTypeForGeneratedFileName(fileName);
    if (contentType === undefined) return c.json({ error: 'invalid image file name' }, 400);
    const data = await service.readImage(id, fileName);
    if (data === undefined) return c.json({ error: 'image not found' }, 404);
    c.header('Content-Type', contentType);
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Content-Disposition', 'inline');
    c.header('Cache-Control', 'private, max-age=31536000, immutable');
    return c.body(new Uint8Array(data));
  });

  return app;
}
