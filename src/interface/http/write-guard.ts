import type { Context, MiddlewareHandler } from 'hono';
import { isLocalBasicAuthRequest } from './local-request.js';

/**
 * 書き込み系リクエストの認可を 1 箇所に集約したガード(bdboard-9rz)。
 *
 * 以前は各ルートのハンドラ先頭で `if (!isLocalBasicAuthRequest(c))` を書いていた。
 * その形だと「次に足されるエンドポイントがガードを書き忘れたまま無防備に出荷される」
 * のを止められない。ここではメソッド(POST/PUT/PATCH/DELETE)で前方に効くミドルウェアに
 * 変え、ルーティング解決より前に判定する。新しい書き込みルートは、登録しただけで
 * 自動的にこのガードの内側に入る。
 *
 * 判定は 2 段:
 *   1. CSRF: トンネル URL は公開されるので、書き込みが開くと外部サイトからの
 *      クロスオリジン POST が現実的な脅威になる。下記 3 レイヤで弾く。
 *   2. 認可: ローカル直アクセス || (トンネルセッション Cookie が有効 &&
 *      そのトンネルのパスワードが書き込み開放の強度要件を満たす)。
 *      依存が渡されていない場合は従来どおり localhost 限定にフォールバックする
 *      (fail-closed)。
 */

const MUTATING_METHODS: ReadonlySet<string> = new Set([
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
]);

const JSON_MEDIA_TYPE = 'application/json';

export interface WriteGuardDeps {
  /** 現在のトンネルが書き込みを開放してよい資格情報で起動されているか */
  readonly isTunnelWriteAllowed?: () => boolean;
  /** このリクエストが現在のトンネルセッション Cookie を持っているか */
  readonly hasTunnelSession?: (c: Context) => boolean;
}

export type WriteGuardDecision =
  | { readonly kind: 'allow' }
  | { readonly kind: 'deny'; readonly reason: 'csrf' | 'not-authorized' };

export function isMutatingMethod(method: string): boolean {
  return MUTATING_METHODS.has(method.toUpperCase());
}

function mediaType(contentType: string): string {
  const semicolon = contentType.indexOf(';');
  const raw = semicolon === -1 ? contentType : contentType.slice(0, semicolon);
  return raw.trim().toLowerCase();
}

/** Content-Length / Transfer-Encoding からボディの有無を判定する */
function hasRequestBody(headers: Headers): boolean {
  if (headers.get('transfer-encoding') !== null) {
    return true;
  }
  const contentLength = headers.get('content-length');
  if (contentLength === null) {
    return false;
  }
  const parsed = Number.parseInt(contentLength, 10);
  return Number.isFinite(parsed) && parsed > 0;
}

function sameOriginByHost(originHeader: string, hostHeader: string | null): boolean {
  if (hostHeader === null || hostHeader.length === 0) {
    return false;
  }
  try {
    return new URL(originHeader).host.toLowerCase() === hostHeader.toLowerCase();
  } catch {
    return false;
  }
}

/**
 * クロスサイトからの書き込みを弾く。独自ヘッダ必須化ではなくこの 3 レイヤを選んだ
 * 理由は SKILL 的な補足として: 独自ヘッダの実効メカニズムは「単純リクエストで
 * なくなり CORS プリフライトが必須になる」ことだが、`Content-Type: application/json`
 * の必須化はそれと同じ効果を持つ(本アプリは CORS ヘッダを一切返さないのでプリフライトは
 * 必ず失敗する)。独自ヘッダとの唯一の差は「ボディ無し/Content-Type 無しの単純
 * リクエスト」で、そこは (1) と (3) が塞ぐ。
 */
export function checkCsrf(headers: Headers): boolean {
  // (1) Fetch Metadata。モダンブラウザは常に送る。Host 書き換えの影響を受けないので
  //     cloudflared を挟んでも判定が壊れない。same-origin 以外は一律拒否
  //     (same-site も許さない: trycloudflare.com のような共有ドメイン下では
  //     別サブドメインの攻撃者ページが same-site になりうる)。
  const secFetchSite = headers.get('sec-fetch-site');
  if (secFetchSite !== null && secFetchSite.trim().toLowerCase() !== 'same-origin') {
    return false;
  }

  // (2) Content-Type。HTML フォームは application/x-www-form-urlencoded /
  //     multipart/form-data / text/plain しか送れないので、これだけでフォーム CSRF は
  //     成立しない。ボディを持つのに Content-Type が無いリクエスト(Blob ボディの
  //     no-cors fetch 等)は単純リクエストとして飛ばせてしまうので拒否する。
  const contentType = headers.get('content-type');
  if (contentType !== null) {
    if (mediaType(contentType) !== JSON_MEDIA_TYPE) {
      return false;
    }
  } else if (hasRequestBody(headers)) {
    return false;
  }

  // (3) Origin。Sec-Fetch-Site を送らない古いブラウザ向けの保険。
  //     Sec-Fetch-Site があるときは (1) の方が確実なのでここは見ない
  //     (cloudflared が Host を書き換えた場合の誤判定を避ける)。
  if (secFetchSite === null) {
    const origin = headers.get('origin');
    if (origin !== null && !sameOriginByHost(origin, headers.get('host'))) {
      return false;
    }
  }

  return true;
}

export function evaluateWriteAccess(
  c: Context,
  deps: WriteGuardDeps,
): WriteGuardDecision {
  if (!checkCsrf(c.req.raw.headers)) {
    return { kind: 'deny', reason: 'csrf' };
  }

  if (isLocalBasicAuthRequest(c)) {
    return { kind: 'allow' };
  }

  const isTunnelWriteAllowed = deps.isTunnelWriteAllowed;
  const hasTunnelSession = deps.hasTunnelSession;
  if (isTunnelWriteAllowed === undefined || hasTunnelSession === undefined) {
    return { kind: 'deny', reason: 'not-authorized' };
  }

  // パスワード強度の判定を先に見る。強度不足のトンネルでは、有効なセッション Cookie を
  // 持っていても書き込みは開かない(= 従来どおり localhost 限定へフォールバック)。
  if (!isTunnelWriteAllowed()) {
    return { kind: 'deny', reason: 'not-authorized' };
  }

  if (!hasTunnelSession(c)) {
    return { kind: 'deny', reason: 'not-authorized' };
  }

  return { kind: 'allow' };
}

/**
 * 拒否時の応答文言。既定は書き込みガードのもの。
 * チャットのように「書き込み」と呼ぶと意味が通らない用途では差し替える。
 */
export interface GuardDenyMessages {
  readonly csrf?: string;
  readonly notAuthorized?: string;
}

function denyResponse(
  c: Context,
  decision: Extract<WriteGuardDecision, { kind: 'deny' }>,
  messages: GuardDenyMessages,
): Response {
  if (decision.reason === 'csrf') {
    return c.json(
      { error: messages.csrf ?? 'cross-site write blocked' },
      403,
    );
  }
  return c.json({ error: messages.notAuthorized ?? 'local access only' }, 403);
}

export function createWriteGuardMiddleware(
  deps: WriteGuardDeps = {},
): MiddlewareHandler {
  return async (c, next) => {
    if (!isMutatingMethod(c.req.method)) {
      await next();
      return;
    }

    const decision = evaluateWriteAccess(c, deps);
    if (decision.kind === 'deny') {
      return denyResponse(c, decision, {});
    }

    await next();
  };
}

/**
 * メソッドを問わず、書き込みと同じ認可をすべてのリクエストに要求するガード
 * (bdboard-cu4)。
 *
 * `createWriteGuardMiddleware` はメソッドで前置判定するので、GET は素通しになる。
 * それで正しいのは「GET が本当に読み取りである」API だけで、チャットは違う:
 * `GET /api/chat/availability` はローカルの claude CLI を子プロセス起動して
 * 到達性を測る。副作用とコストを持つ GET なので、書き込みと同じ資格を要求する。
 * 判定そのもの(CSRF 3 レイヤ + ローカル直 || 強パスワード&セッション)は
 * `evaluateWriteAccess` をそのまま再利用し、条件を二重定義しない。
 */
export function createPrivilegedApiGuardMiddleware(
  deps: WriteGuardDeps = {},
  messages: GuardDenyMessages = {},
): MiddlewareHandler {
  return async (c, next) => {
    const decision = evaluateWriteAccess(c, deps);
    if (decision.kind === 'deny') {
      return denyResponse(c, decision, messages);
    }

    await next();
  };
}
