/**
 * bdboard-4y8q.6.4: API の 5xx 応答と処理されなかった例外を、本体エラー (種類 C) の下書きにする。
 *
 * - `createServerErrorCapture()` は compression の内側 (圧縮前の本文が見える位置) に mount する middleware。`await next()` の後で status >= 500 を拾い、
 *   self-error reporter (6.3) の `report()` に渡す。間引きは reporter が持つ (リフレッシュの失敗と同じ throttle を共有する)。
 * - `serverErrorHandler` は `app.onError` に付ける。処理されなかった例外に、stack を入れない 500 の JSON を返す。
 * - 応答に `X-Bdboard-Error-Draft: recorded|throttled|skipped` を付ける (画面が同じ失敗を二重に報告しないための印)。
 *
 * 中身の規則は docs/ISSUE-REPORTING.md「本体エラーの取り込み (4y8q.6.4、API の失敗)」。この middleware は応答の中身を作り替えない (ヘッダーを足すだけ)。
 */
import type { Context, ErrorHandler, MiddlewareHandler } from 'hono';
import { routePath } from 'hono/route';
import type { SelfErrorReporter } from '../../application/issue-report/self-error-reporter.js';
import { selfErrorApiSource } from '../../domain/self-error-source.js';

export const ERROR_DRAFT_HEADER = 'X-Bdboard-Error-Draft';
/**
 * `recorded`: この要求が下書きに保存した。`throttled`: 同じ失敗がもう保存できている (1 時間以内。保存中の同じ失敗の 1 回目が成功した場合を含む)。
 * `skipped`: 拾わない・保存できなかった (その失敗は間引きの記録に残らず、次の同じ失敗がもう一度保存を試みる)・内部の失敗・時間切れ (bdboard-4y8q.6.10)。
 */
export type ErrorDraftHeaderValue = 'recorded' | 'throttled' | 'skipped';

export interface ServerErrorCaptureDeps {
  readonly reporter: Pick<SelfErrorReporter, 'report'>;
}

/** 本文を読むのは、これ以下のときだけ (超えたら本文は取り込まない)。 */
const BODY_READ_LIMIT_BYTES = 16 * 1024;
/** 例外の name・message・stack の上限 (伏せる処理の入力を抑える。保存の上限は下書き側が別にかける)。 */
const ERROR_TEXT_MAX_CHARS = 16 * 1024;
/** 本文を読んで reporter に渡し終えるまでの上限。保存が遅くてもエラー応答を待たせ続けない (超えたら `skipped`)。 */
const CAPTURE_TIMEOUT_MS = 2_000;
/** 未対応の機能 (501) と、下書きの保存先がいっぱい (507) は本体の不具合ではない。 */
const NOT_REPORTED_STATUSES: readonly number[] = [501, 507];
/** 受け取り口そのものの失敗を、また受け取り口へ送らない (再帰の防止)。 */
const ISSUE_REPORTS_PREFIX = '/api/issue-reports';
/**
 * 状態コードと `error` のラベルだけを取り込む領域。接続の URL・認証・会話の本文 (tunnel・chat)、
 * エージェントへの指示・会話・作業のパス (runs・sessions) が本文や例外に入りうる。
 */
const LABEL_ONLY_PREFIXES: readonly string[] = ['/api/tunnel', '/api/chat', '/api/runs', '/api/sessions'];
const LABEL_PATTERN = /^[A-Za-z0-9 _,'-]{1,80}$/;
const ERROR_NAME_PATTERN = /^[A-Za-z0-9_$]{1,60}$/;

function pathHasPrefix(path: string, prefix: string): boolean {
  return path.toLowerCase().startsWith(prefix);
}

function isEventStream(res: Response): boolean {
  return (res.headers.get('content-type') ?? '').toLowerCase().includes('text/event-stream');
}

function isJson(res: Response): boolean {
  return (res.headers.get('content-type') ?? '').toLowerCase().includes('application/json');
}

/** 本文を最大 limit バイトまで読む。超えたら読むのをやめて undefined (呼び出し側は本文を取り込まない)。 */
async function readBounded(res: Response, limit: number): Promise<string | undefined> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) return undefined;
  if (res.body === null) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      // 待たない: 複製 (tee) の片方の cancel は、もう片方 (元の応答) も読み終わる・cancel されるまで解決しない。
      void reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/** JSON の応答 (object) を、元の応答を消費しない複製から読む。JSON でない・大きい・壊れているときは undefined。 */
async function readJsonObject(res: Response): Promise<Record<string, unknown> | undefined> {
  if (!isJson(res)) return undefined;
  const text = await readBounded(res.clone(), BODY_READ_LIMIT_BYTES);
  if (text === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function stringField(object: Record<string, unknown>, key: string): string | undefined {
  const value = object[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** 手元に残す例外の文: name・message・stack (stack は先頭に name: message を含むのがふつうなので、含まれていれば重ねない)。 */
function describeError(error: Error): string {
  const head = `${error.name}: ${error.message}`;
  const stack = typeof error.stack === 'string' ? error.stack : '';
  return (stack.startsWith(head) ? stack : `${head}\n${stack}`).trim().slice(0, ERROR_TEXT_MAX_CHARS);
}

/** ラベルだけの領域で例外から取り出してよいのはクラス名だけ (message と stack に URL・認証・本文が入りうる)。 */
function safeErrorName(error: Error): string {
  return ERROR_NAME_PATTERN.test(error.name) ? error.name : 'Error';
}

/** 手元に残す失敗の文。ラベルだけの領域では、状態コードと (形の合う) `error` のラベル・例外のクラス名だけ。 */
async function describeFailure(c: Context, status: number, labelOnly: boolean, nonErrorThrown: boolean): Promise<string> {
  const lines = [`HTTP ${status}`];
  if (c.error !== undefined) {
    lines.push(labelOnly ? safeErrorName(c.error) : describeError(c.error));
  } else if (nonErrorThrown) {
    lines.push('non-Error value thrown');
  } else {
    const body = await readJsonObject(c.res);
    const label = body === undefined ? undefined : stringField(body, 'error');
    const detail = body === undefined ? undefined : stringField(body, 'detail');
    if (label !== undefined && (!labelOnly || LABEL_PATTERN.test(label))) lines.push(`error: ${label}`);
    if (detail !== undefined && !labelOnly) lines.push(`detail: ${detail.slice(0, ERROR_TEXT_MAX_CHARS)}`);
  }
  return lines.join('\n');
}

/** Hono に登録したルートのパターン (具体的な ID は入らない)。取れないときは空文字 (source は `(unknown route)` になる)。 */
function matchedRoute(c: Context): string {
  try {
    return routePath(c);
  } catch {
    return '';
  }
}

async function capture(c: Context, reporter: ServerErrorCaptureDeps['reporter'], nonErrorThrown: boolean): Promise<ErrorDraftHeaderValue> {
  const status = c.res.status;
  if (NOT_REPORTED_STATUSES.includes(status) || pathHasPrefix(c.req.path, ISSUE_REPORTS_PREFIX)) return 'skipped';
  const labelOnly = LABEL_ONLY_PREFIXES.some((prefix) => pathHasPrefix(c.req.path, prefix));
  const errorText = await describeFailure(c, status, labelOnly, nonErrorThrown);
  // Hono は HEAD を GET の handler で答える。同じ失敗を `api:HEAD` の別の source (別の間引きのキー・別の下書き) に分けない。
  const method = c.req.method === 'HEAD' ? 'GET' : c.req.method;
  return reporter.report({ source: selfErrorApiSource(method, matchedRoute(c)), errorText });
}

/** capture を、時間の上限つきで・決して reject せずに待つ。 */
async function settle(c: Context, reporter: ServerErrorCaptureDeps['reporter'], nonErrorThrown: boolean): Promise<ErrorDraftHeaderValue> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<ErrorDraftHeaderValue>((resolve) => {
    timer = setTimeout(() => resolve('skipped'), CAPTURE_TIMEOUT_MS);
    timer.unref();
  });
  const work = capture(c, reporter, nonErrorThrown).catch((): ErrorDraftHeaderValue => 'skipped');
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function createServerErrorCapture(deps: ServerErrorCaptureDeps): MiddlewareHandler {
  return async (c, next) => {
    // Hono の errorHandler が受けるのは Error だけ。Error でない値 (文字列など) の throw はここまで届くので、500 の JSON にして同じく拾う。
    let nonErrorThrown = false;
    try {
      await next();
    } catch (error) {
      // ここへ来た値は serverErrorHandler を通っていない (ログに出ていない)。
      console.error(error);
      if (error instanceof Error) c.error = error;
      else nonErrorThrown = true;
      c.res = c.json({ error: 'internal error' }, 500);
    }
    if (c.res.status < 500) return;
    // SSE は触らない (ヘッダーの付け直しで本文の流れを作り直さない)。
    if (isEventStream(c.res)) return;
    c.header(ERROR_DRAFT_HEADER, await settle(c, deps.reporter, nonErrorThrown));
  };
}

/** `app.onError` に付ける。stack・message は応答に入れない (console.error には今までどおり出す)。HTTPException は Hono の既定と同じく、その応答をそのまま返す。 */
export const serverErrorHandler: ErrorHandler = (error, c) => {
  if ('getResponse' in error) {
    const res = error.getResponse();
    return c.newResponse(res.body, res);
  }
  console.error(error);
  return c.json({ error: 'internal error' }, 500);
};
