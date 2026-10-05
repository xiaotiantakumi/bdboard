import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import type { IssueDraftService } from '../../application/issue-report/issue-draft-service.js';
import { createRestrictedLeakCache, type RestrictedLeakCache } from './issue-report-leak-cache.js';
import {
  ISSUE_DRAFT_DISMISS_REASON_MAX_CHARS,
  ISSUE_DRAFT_MAX_IMAGES,
  isDraftId,
} from '../../domain/issue-draft.js';
import {
  hasVisibleText,
  isSingleLineDisplayText,
  isSingleLineText,
  sanitizeProjectName,
  stripPasteArtifacts,
} from '../../domain/issue-draft-identifier.js';
import {
  ATTACHMENT_ALLOWED_MIME_TYPES,
  ATTACHMENT_BODY_MAX_BYTES,
  contentTypeForGeneratedFileName,
  decodeAttachmentImage,
  extensionForMimeType,
} from './attachment-validation.js';
import { ISSUE_DRAFTS_PATH, toImageDto, toSummaryDto } from './issue-report-dto.js';
import { registerIssueDraftEditRoutes } from './issue-report-edit-routes.js';
import { buildDetailBody, detailEtagOf, jsonWithEtag, listEtagOf } from './issue-report-etag.js';
import { isLocalBasicAuthRequest } from './local-request.js';
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
 *   - 一覧の取得 (GET): ほかの読み取り API と同じ。トンネルではトンネルの認証 (Basic 認証) を通れば読める。
 *     一覧と 1 件の取得は ETag を付け、If-None-Match が一致すれば 304 (bdboard-mqoa。issue-report-etag.ts)。
 *   - 画像の取得 (GET drafts/:id/images/:fileName): ローカル直アクセスのみ (bdboard-4y8q.3.2。生ログと同じ扱い)。
 *   - 1 件の取得 (GET drafts/:id): 全部を返すのはローカル直アクセスだけ。トンネル経由は
 *     生ログ・自由記述の生の文・絶対パスを除いた形 (`restricted: true`、toDetailDto)。
 *   - 見送り (PATCH dismiss) と題名・本文の編集 (PATCH drafts/:id、issue-report-edit-routes.ts): 通常の write-guard
 *     (ローカル直、または強パスワード + セッション)。編集は If-Match で、読んだ版と今の版が違えば 412 (bdboard-mqoa)。
 *   - 未処理件数 (GET pending-count、issue-report-edit-routes.ts): ほかの読み取り API と同じ。
 *
 * このルーターは何も外へ送らない。投稿 (bdboard-4y8q.4) は別の経路。
 */

/** 受け取り POST の上限。長いエラー文は受けてから先頭と末尾だけ残す (捨てずに切り詰める)。 */
export const ISSUE_REPORT_BODY_MAX_BYTES = 1024 * 1024;
const DISMISS_BODY_MAX_BYTES = 16 * 1024;

/**
 * 受け取りと画像の追加が、issue-drafts の合計容量の上限 (終端の下書きを消しても空かない) に当たったときの
 * 本文 (507)。`code` は機械が読む固定の値 (bdboard-00qh、docs/ISSUE-REPORTING.md 4節)。
 */
export const STORAGE_FULL_BODY = { error: 'issue draft storage is full', code: 'storage-full' } as const;

/** 見送り・投稿済みの下書きへの画像の追加 (409)。`code` は機械が読む固定の値、`status` は下書きの今の状態。 */
const draftNotPendingBody = (status: string) =>
  ({ error: 'images can only be added to a pending draft', code: 'draft-not-pending', status }) as const;

const SINGLE_LINE_MESSAGE = 'must be a single line without control, invisible or format characters';

/**
 * 識別子 (source・catalogSlug・版の文字列) は、改行・制御文字・不可視の書式文字 (ゼロ幅・双方向制御・
 * BOM・タグ文字・ハングルの埋め字など) を含めない。含めると行を足して見出しやリンクを公開本文へ
 * 紛れ込ませたり、見えない文字で別の値に見せかけたりできるので、厳密に 400 にする。
 * これで防ぐのは行の数と見えない文字だけ: 1 行でもリンク・@メンション・#参照・<img> は書ける。
 * インラインの Markdown のエスケープと公開本文の置き換えは 4y8q.2 の仕事。パスの形かどうかは
 * ここでは見ない (source は "GET /api/x" のような API のパスでもよい)。ホーム配下の絶対パスは
 * 受け取りのサービスが "~/" に畳む (canonicalizeReceiveInput)。
 * 表示用の欄 (project.name・見送りの理由) は人が書くので、厳密に弾かずに整えて受ける (下の二つ)。
 */
const singleLine = (max: number) => z.string().max(max).refine(isSingleLineText, SINGLE_LINE_MESSAGE);
const versionString = singleLine(100);

/**
 * プロジェクト名 (表示用): 絵文字の連結 (👩‍💻-tools) などで 400 にしないよう、弾く文字は取り除いて受け、
 * ホーム配下のパスは "~/" に畳む (sanitizeProjectName)。改行・タブなどパスの区切りにもなる文字と、画面では
 * 空白に見えるハングルの埋め字・U+180E は、取り除かず空白に替えてから畳む (つなげるとパスが前の語に貼り付いて
 * 畳めないため)。結果が空なら 400。
 */
export const projectNameSchema = z
  .string()
  .max(200)
  .transform(sanitizeProjectName)
  .pipe(z.string().min(1, 'must not be empty after removing control, invisible or format characters'));

/**
 * 元チケットの参照 (bd の id)。トンネルの読み手へ返し、後で bd のコマンドの引数に使う (4y8q.4) ので、
 * 先頭は英数字、あとは英数字と . _ - だけ。"--db=/tmp/x" のようなオプションの形は通さない。
 */
const TICKET_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

const receiveBodySchema = z.object({
  kind: z.enum(['A', 'B', 'C']),
  catalogSlug: singleLine(200).pipe(z.string().min(1)).optional(),
  source: singleLine(200).pipe(z.string().min(1)).optional(),
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
  project: z.object({ name: projectNameSchema, path: z.string().max(1000) }).optional(),
  sourceTicketRef: z.string().regex(TICKET_REF_PATTERN, 'must look like a ticket id').optional(),
});

// 一言 (1 行)。貼り付けで混ざるゼロ幅スペースと BOM は落とし、前後の空白も落とす。絵文字の連結 (ZWJ・ZWNJ) は
// 許す。改行・制御文字・そのほかの不可視の書式文字が途中にあれば 400 (末尾の改行も含めて、整える前の値で見る)。
// 整えたあとに見える文字が残らない (空白・ZWJ・ZWNJ・結合文字 \p{M}・点字の空白 U+2800 だけ) ものも 400。
const dismissBodySchema = z.object({
  reason: z
    .string()
    .transform(stripPasteArtifacts)
    .refine(isSingleLineDisplayText, SINGLE_LINE_MESSAGE)
    .refine(hasVisibleText, 'must contain visible text')
    .pipe(z.string().trim().min(1).max(ISSUE_DRAFT_DISMISS_REASON_MAX_CHARS)),
});

const imageBodySchema = z.object({
  mimeType: z.enum(ATTACHMENT_ALLOWED_MIME_TYPES),
  data: z.string().min(1),
});

export interface IssueReportRoutesDeps {
  readonly service: IssueDraftService;
  readonly leakCache?: RestrictedLeakCache;
  /** 見送り・編集 (PATCH) にだけ効く。省略時はローカル直アクセス限定 (fail-closed)。 */
  readonly writeAccess?: WriteGuardDeps;
  /**
   * この bdboard が配る最新の harness pack (bdboard-harness) の版 (bdboard-4y8q.3.1)。1 件の取得の応答に
   * `latestHarnessVersion` として載せ、画面が下書きの harnessVersionAtOccurrence と並べる。省略・読めないときは null。
   */
  readonly latestHarnessVersion?: () => Promise<string | undefined>;
}

/** 最新の harness pack の版。読めなくても 1 件の取得は落とさない (版の比較が出ないだけ)。 */
async function readLatestHarnessVersion(deps: IssueReportRoutesDeps): Promise<string | null> {
  if (deps.latestHarnessVersion === undefined) return null;
  try {
    return (await deps.latestHarnessVersion()) ?? null;
  } catch {
    return null;
  }
}

function limitBody(maxSize: number) {
  return bodyLimit({ maxSize, onError: (c) => c.json({ error: 'request body too large' }, 413) });
}

export function createIssueReportRoutes(deps: IssueReportRoutesDeps): Hono {
  const app = new Hono();
  const { service } = deps;
  const leakCache = deps.leakCache ?? createRestrictedLeakCache();

  // このサブアプリは inner (routes.ts) と兄弟として mount されるので、inner のブランケットの
  // 書き込みガードに頼らず、自分で全メソッドの書き込み系に掛ける (attachment-routes.ts と同じ理由)。
  app.use('/api/issue-reports/*', createWriteGuardMiddleware(deps.writeAccess ?? {}));

  // ローカル直アクセスだけ。トンネル用の依存を渡さないので、トンネルセッションがあっても 403。
  const localOnlyGuard = createPrivilegedApiGuardMiddleware({});

  app.post(ISSUE_DRAFTS_PATH, localOnlyGuard, limitBody(ISSUE_REPORT_BODY_MAX_BYTES), async (c) => {
    // 400 の本文は固定の文言だけ。理由 (details) は返さない: zod の既定の文言は入力の値をそのまま含む
    // (z.enum の invalid_enum_value は "received '<値>'") ので、書き込んだ側へ値がそのまま戻り、応答を残すログや
    // 呼び出し側のログにも値が残る。この受け取りは localOnlyGuard の後ろ (トンネルは 403) なので、理由はトンネルではなく、
    // 値を書き手とログへ戻さないこと。
    const parsed = await parseJsonBody(c, receiveBodySchema);
    if (!parsed.ok) return parsed.response;

    const result = await service.receive(parsed.data);
    if (!result.ok) {
      if (result.reason === 'storage-full') return c.json(STORAGE_FULL_BODY, 507);
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
    // 未処理件数は、読んだ一覧そのものからサービスが数える (画面の一覧と食い違わない。数え方は GET pending-count と同じ 1 つ)。
    const { drafts, pendingCount } = await service.listWithPendingCount();
    // ETag は本文から作るので、並び順と未処理件数の変化でも変わる (issue-report-etag.ts)。
    const body = { drafts: drafts.map(toSummaryDto), pendingCount };
    return jsonWithEtag(c, body, listEtagOf(body));
  });

  app.get(`${ISSUE_DRAFTS_PATH}/:id`, async (c) => {
    const id = c.req.param('id');
    if (!isDraftId(id)) return c.json({ error: 'invalid draft id' }, 400);
    const draft = await service.get(id);
    if (draft === undefined) return c.json({ error: 'draft not found', id }, 404);
    // 全部を返すのはローカル直アクセスだけ。判定できない・疑わしいときは絞った形 (fail-closed)。
    const local = isLocalBasicAuthRequest(c);
    const body = await buildDetailBody({ service, leakCache }, draft, { local, latestHarnessVersion: await readLatestHarnessVersion(deps) });
    return jsonWithEtag(c, body, detailEtagOf(body));
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

  registerIssueDraftEditRoutes(app, { service, leakCache, readLatestHarnessVersion: () => readLatestHarnessVersion(deps) });

  app.post(`${ISSUE_DRAFTS_PATH}/:id/images`, localOnlyGuard, limitBody(ATTACHMENT_BODY_MAX_BYTES), async (c) => {
    const id = c.req.param('id');
    if (!isDraftId(id)) return c.json({ error: 'invalid draft id' }, 400);
    // 10MB 級のデコードをする前に、下書きの存在と状態を先に確かめる (状態の判定の正はサービス。これは先回り)。
    const draft = await service.get(id);
    if (draft === undefined) return c.json({ error: 'draft not found', id }, 404);
    if (draft.status !== 'pending') return c.json(draftNotPendingBody(draft.status), 409);

    const parsed = await parseJsonBody(c, imageBodySchema);
    if (!parsed.ok) return parsed.response;

    // 添付画像と同じ検査 (base64 の厳密デコード・マジックバイト・1 枚 10MB)。
    const { mimeType } = parsed.data;
    const decoded = decodeAttachmentImage(mimeType, parsed.data.data);
    if (decoded === undefined) return c.json({ error: 'invalid or unsupported image data' }, 400);

    const result = await service.addImage(id, extensionForMimeType(mimeType), decoded);
    if (!result.ok) {
      switch (result.reason) {
        case 'not-found':
          return c.json({ error: 'draft not found', id }, 404);
        case 'storage-full':
          return c.json(STORAGE_FULL_BODY, 507);
        case 'not-pending':
          return c.json(draftNotPendingBody(result.status), 409);
        case 'limit-reached':
          return c.json({ error: `image limit reached (max ${ISSUE_DRAFT_MAX_IMAGES} per draft)` }, 409);
      }
    }
    return c.json({ image: toImageDto(id, result.image) }, 201);
  });

  // 画像はローカル直アクセスだけ (bdboard-4y8q.3.2)。スクリーンショットには生ログと同じ種類の秘密が写りうるので、
  // トンネル経由では生ログと同じく見せない。画面もトンネル経由では画像をリンクにしない。
  app.get(`${ISSUE_DRAFTS_PATH}/:id/images/:fileName`, localOnlyGuard, async (c) => {
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
