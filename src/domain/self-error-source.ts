/**
 * bdboard 本体のエラーの下書きに付ける出どころ (source) の語彙 (bdboard-4y8q.6.4)。
 *
 * source は下書きの指紋 (`C:<source>:<ハッシュ>`) と題名 (`[bdboard 本体] <source>`) にそのまま入るので、パス・プロジェクト名・ID・本文の断片が
 * 入り込まない閉じた形だけを通す。`report()` (self-error-reporter.ts) が受け付けるのは、いまは API の失敗の形だけ:
 *
 *   `api:<METHOD> <route>`  例: `api:GET /api/tickets/:id{.+}`
 *
 * `<METHOD>` は下の許可リストのどれか、`<route>` は Hono に登録したルートのパターン (リクエストのパスではない。具体的な ID は入らない)。
 * 画面のエラー (4y8q.6.5) の語彙はそのチケットがここに足す。リフレッシュの失敗の `bd-refresh:<kind>` は tracker が作るので `report()` を通らない。
 */
const API_METHODS: readonly string[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
/** ルートが許可リスト外のメソッド (HTTP の任意のトークン) のときの印。 */
export const SELF_ERROR_OTHER_METHOD = 'OTHER';
/** ルートが分からない、または形が合わないときの印 (リクエストのパスは入れない)。 */
export const SELF_ERROR_UNKNOWN_ROUTE = '(unknown route)';
export const SELF_ERROR_SOURCE_MAX_LENGTH = 200;

/** Hono のルートのパターンに現れる文字だけ (`/api/tickets/:id{.+}`、`/*`、`*`)。空白・引用符・`%`・`@` などは入れない。 */
const ROUTE_PATTERN = /^(?:\/[A-Za-z0-9_.:/*{}+?()[\]\\^$|,-]*|\*)$/;

export type SelfErrorApiSource = `api:${string}`;

function routeOf(route: string): string {
  return ROUTE_PATTERN.test(route) ? route : SELF_ERROR_UNKNOWN_ROUTE;
}

/** `api:<METHOD> <route>` を組む。メソッドは大文字にして許可リストに無ければ `OTHER`、ルートは形が合わなければ `(unknown route)`。 */
export function selfErrorApiSource(method: string, route: string): SelfErrorApiSource {
  const upper = method.toUpperCase();
  const verb = API_METHODS.includes(upper) ? upper : SELF_ERROR_OTHER_METHOD;
  const source: SelfErrorApiSource = `api:${verb} ${routeOf(route)}`;
  return source.length <= SELF_ERROR_SOURCE_MAX_LENGTH ? source : `api:${verb} ${SELF_ERROR_UNKNOWN_ROUTE}`;
}

/** `report()` が受け付ける source か (上の形に一致するものだけ)。 */
export function isReportableSelfErrorSource(source: string): source is SelfErrorApiSource {
  if (source.length > SELF_ERROR_SOURCE_MAX_LENGTH || !source.startsWith('api:')) return false;
  const rest = source.slice('api:'.length);
  const space = rest.indexOf(' ');
  if (space < 0) return false;
  const method = rest.slice(0, space);
  const route = rest.slice(space + 1);
  return (
    (API_METHODS.includes(method) || method === SELF_ERROR_OTHER_METHOD) &&
    (route === SELF_ERROR_UNKNOWN_ROUTE || ROUTE_PATTERN.test(route))
  );
}
