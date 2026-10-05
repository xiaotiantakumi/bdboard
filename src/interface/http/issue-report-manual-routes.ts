import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import type { IssueDraftService } from '../../application/issue-report/issue-draft-service.js';
import { ISSUE_DRAFT_FREE_TEXT_MAX_CHARS } from '../../domain/issue-draft.js';
import { ISSUE_DRAFT_TITLE_MAX_CHARS } from '../../domain/issue-draft-edit.js';
import { hasVisibleText, isSingleLineDisplayText, stripPasteArtifacts } from '../../domain/issue-draft-identifier.js';
import { toSummaryDto } from './issue-report-dto.js';
import { projectNameSchema, STORAGE_FULL_BODY } from './issue-report-routes.js';
import { parseJsonBody } from './request-body.js';
import { createPrivilegedApiGuardMiddleware } from './write-guard.js';

/**
 * 人が画面から手で書く不具合報告の受け取り口 (bdboard-4y8q.6.7、「新しく報告」。docs/ISSUE-REPORTING.md 3節の `manual-drafts` の行)。
 *
 * `POST /api/issue-reports/manual-drafts` は、受け取り (POST drafts) と画像の追加と同じローカル直アクセスのみ
 * (createPrivilegedApiGuardMiddleware にトンネル用の依存を渡さないので、強パスワード + セッション Cookie のトンネルでも 403)。
 * 作った下書きへの画像は、既存の画像の追加 (POST drafts/:id/images) で付ける。
 *
 * - 本文の上限 64KB。題名は 1 行・256 文字まで、説明は 8000 文字までで、どちらも必須。
 * - 1 時間に 20 件まで (自動の受け取りの 20 件/時とは別に数える)。超えたら 429 `manual-rate-limited`、容量切れは 507。
 * - 同じ文を 2 回送っても下書きは 2 件 (まとめない)。
 * - 説明は手元だけの agentNote に入り、公開本文には入らない。題名は「直した題名」として保存し、置き換え漏れの検出をかける。
 *
 * このルーターは何も外へ送らない。投稿 (bdboard-4y8q.4) は別の経路。
 */

export const ISSUE_MANUAL_DRAFTS_PATH = '/api/issue-reports/manual-drafts';

/** POST manual-drafts の本文の上限。説明 8000 文字が JSON のエスケープ (\uXXXX で 6 バイト) で膨らんでも入る大きさ。 */
export const ISSUE_MANUAL_DRAFT_BODY_MAX_BYTES = 64 * 1024;

/** 1 時間あたりの手書きの下書きの上限に達した (429)。`code` は機械が読む固定の値。何も書いていない。 */
const MANUAL_RATE_LIMITED_BODY = {
  error: 'too many manual reports in the last hour',
  code: 'manual-rate-limited',
} as const;

const SINGLE_LINE_MESSAGE = 'must be a single line without control, invisible or format characters';
const VISIBLE_TEXT_MESSAGE = 'must contain visible text';

/**
 * 題名 (1 行、256 文字、必須): 見送りの理由と同じ整え方。貼り付けで混ざるゼロ幅スペースと BOM は落とし、前後の空白も落とす。
 * ZWJ・ZWNJ は許し、改行・制御文字・そのほかの不可視の書式文字が途中にあれば 400。整えたあとに見える文字が残らないものも 400。
 * 説明 (8000 文字、必須): 複数行でよい。手元だけの欄なので文字の種類は見ず、見える文字があるかだけ見る。
 * project は任意: 題名の漏れ検出の鍵 (名前・根のパス) になる (受け取りの project と同じ形)。
 * 400 の本文は固定の文言だけ (受け取りと同じ。入力の値を書き手とログへ戻さない)。
 */
const manualBodySchema = z.object({
  title: z
    .string()
    .transform(stripPasteArtifacts)
    .refine(isSingleLineDisplayText, SINGLE_LINE_MESSAGE)
    .refine(hasVisibleText, VISIBLE_TEXT_MESSAGE)
    .pipe(z.string().trim().min(1).max(ISSUE_DRAFT_TITLE_MAX_CHARS)),
  description: z.string().max(ISSUE_DRAFT_FREE_TEXT_MAX_CHARS).refine(hasVisibleText, VISIBLE_TEXT_MESSAGE),
  project: z.object({ name: projectNameSchema, path: z.string().max(1000) }).optional(),
});

export interface IssueReportManualRoutesDeps {
  readonly service: Pick<IssueDraftService, 'createManual'>;
}

export function createIssueReportManualRoutes(deps: IssueReportManualRoutesDeps): Hono {
  const app = new Hono();

  // ローカル直アクセスだけ。トンネル用の依存を渡さないので、トンネルセッションがあっても 403。
  const localOnlyGuard = createPrivilegedApiGuardMiddleware({});

  app.post(
    ISSUE_MANUAL_DRAFTS_PATH,
    localOnlyGuard,
    bodyLimit({
      maxSize: ISSUE_MANUAL_DRAFT_BODY_MAX_BYTES,
      onError: (c) => c.json({ error: 'request body too large' }, 413),
    }),
    async (c) => {
      const parsed = await parseJsonBody(c, manualBodySchema);
      if (!parsed.ok) return parsed.response;

      const { title, description, project } = parsed.data;
      const result = await deps.service.createManual({
        title,
        description,
        ...(project !== undefined ? { project } : {}),
      });
      if (!result.ok) {
        return result.reason === 'rate-limited' ? c.json(MANUAL_RATE_LIMITED_BODY, 429) : c.json(STORAGE_FULL_BODY, 507);
      }
      // 受け取り (POST drafts) の応答と同じ形。手書きは毎回新しい下書きなので outcome は 'created' だけ。
      return c.json({ outcome: 'created', draft: toSummaryDto(result.draft) }, 201);
    },
  );

  return app;
}
