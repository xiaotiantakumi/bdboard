import type { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import type { IssueDraftService } from '../../application/issue-report/issue-draft-service.js';
import { isDraftId } from '../../domain/issue-draft.js';
import { ISSUE_DRAFT_BODY_MAX_CHARS, ISSUE_DRAFT_TITLE_MAX_CHARS } from '../../domain/issue-draft-edit.js';
import { hasVisibleText, isSingleLineDisplayText, stripPasteArtifacts } from '../../domain/issue-draft-identifier.js';
import { ISSUE_DRAFTS_PATH, toDetailDto } from './issue-report-dto.js';
import { isLocalBasicAuthRequest } from './local-request.js';
import { parseJsonBody } from './request-body.js';

/**
 * 不具合報告の下書きの編集と未処理件数 (bdboard-4y8q.3.1、docs/ISSUE-REPORTING.md 3節「閲覧・編集(PATCH)側のフィールド範囲」)。
 *
 * - PATCH drafts/:id: 書き換えられるのは title / body だけ (どちらか一方でもよい)。ほかのキーは 400 (`.strict()`)。
 *   titleEditedByUser / bodyEditedByUser はサーバーが立てる (送っても 400)。pending 以外は 409。認可は見送りと同じ
 *   通常の write-guard (createIssueReportRoutes が /api/issue-reports/* の全メソッドに掛ける)。
 * - GET pending-count: タブのバッジとデイリーダイジェスト用の未処理件数。サービスの索引から数える。
 */

/** PATCH drafts/:id の本文の上限。本文 65536 文字が JSON のエスケープ (\uXXXX で 6 バイト) で膨らんでも入る大きさ。 */
export const ISSUE_DRAFT_EDIT_BODY_MAX_BYTES = 512 * 1024;
export const ISSUE_REPORTS_PENDING_COUNT_PATH = '/api/issue-reports/pending-count';

/**
 * 題名は 1 行 (見送りの理由と同じ整え方): 貼り付けで混ざるゼロ幅スペースと BOM は落とし、ZWJ・ZWNJ は許し、
 * 改行・制御文字・そのほかの不可視の書式文字は 400、見える文字が残らないものも 400。前後の空白は落とす。
 * 本文は複数行の Markdown なので、文字の種類は見ない (見えない文字を可視化して見せるのは投稿前の確認画面の仕事。
 * docs/ISSUE-REPORTING.md 5節「プレビュー表示時の注意」)。長さは型ではなくハンドラーで見て 413 にする。
 */
const editBodySchema = z
  .object({
    title: z
      .string()
      .transform(stripPasteArtifacts)
      .refine(isSingleLineDisplayText)
      .refine(hasVisibleText)
      .transform((value) => value.trim())
      .optional(),
    body: z.string().optional(),
  })
  .strict()
  .refine((edit) => edit.title !== undefined || edit.body !== undefined);

const TOO_LONG_BODY = {
  error: 'title or body is too long',
  code: 'too-long',
  maxTitleChars: ISSUE_DRAFT_TITLE_MAX_CHARS,
  maxBodyChars: ISSUE_DRAFT_BODY_MAX_CHARS,
} as const;

export interface IssueDraftEditRoutesDeps {
  readonly service: IssueDraftService;
}

export function registerIssueDraftEditRoutes(app: Hono, deps: IssueDraftEditRoutesDeps): void {
  const { service } = deps;

  app.get(ISSUE_REPORTS_PENDING_COUNT_PATH, async (c) => c.json({ pendingCount: await service.pendingCount() }));

  app.patch(
    `${ISSUE_DRAFTS_PATH}/:id`,
    bodyLimit({
      maxSize: ISSUE_DRAFT_EDIT_BODY_MAX_BYTES,
      onError: (c) => c.json({ error: 'request body too large' }, 413),
    }),
    async (c) => {
      const id = c.req.param('id');
      if (!isDraftId(id)) return c.json({ error: 'invalid draft id' }, 400);
      // 400 の本文は固定の文言だけ (受け取り・見送りと同じ。入力の値を書き手とログへ戻さない)。
      const parsed = await parseJsonBody(c, editBodySchema);
      if (!parsed.ok) return parsed.response;
      const edit = parsed.data;
      if ((edit.title?.length ?? 0) > ISSUE_DRAFT_TITLE_MAX_CHARS || (edit.body?.length ?? 0) > ISSUE_DRAFT_BODY_MAX_CHARS) {
        return c.json(TOO_LONG_BODY, 413);
      }

      const result = await service.edit(id, {
        ...(edit.title !== undefined ? { title: edit.title } : {}),
        ...(edit.body !== undefined ? { body: edit.body } : {}),
      });
      if (result.ok) return c.json({ draft: toDetailDto(result.draft, { local: isLocalBasicAuthRequest(c) }) });
      switch (result.reason) {
        case 'not-found':
          return c.json({ error: 'draft not found', id }, 404);
        case 'not-pending':
          return c.json({ error: 'draft is not pending', status: result.status }, 409);
        case 'too-large':
          return c.json({ error: 'draft would exceed the size limit', code: 'draft-too-large' }, 413);
        case 'storage-full':
          return c.json({ error: 'issue draft storage is full', code: 'storage-full' }, 507);
      }
    },
  );
}
