/**
 * トンネル経由のチャット API に対する固定窓レート制限 (bdboard-b7n)。
 *
 * なぜトンネルだけか: リスクは cloudflared という公開経路に固有のもので、localhost は
 * 運用者自身の端末。判定は既存の isLocalControlRequest() に委ね、ここではトンネル由来の
 * リクエストだけを数える。
 *
 * なぜ合計 1 本か: セッション単位に割るとセッションを増やせば上限も増え、コスト上限として
 * 機能しない。トンネル経由の呼び出しはすべて 1 本のカウンタで数える。
 *
 * なぜ永続化しないか: インメモリで十分。サーバー再起動で日次カウンタがリセットされるのは
 * 承知のうえ(再起動は運用者の明示的なローカル操作であり、攻撃者が引き起こせない)。
 * 永続化の複雑さに見合わない。
 */
import type { Context, MiddlewareHandler } from 'hono';
import { isLocalControlRequest } from './local-request.js';

export const DEFAULT_CHAT_RATE_LIMIT_PER_MINUTE = 10;
export const DEFAULT_CHAT_RATE_LIMIT_PER_DAY = 100;
export const CHAT_RATE_LIMITED = 'chat rate limit exceeded';

export const DEFAULT_CHAT_RATE_LIMIT_WEIGHT = 1;

const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 86_400_000;

export type ChatRateLimitDecision =
  | { readonly kind: 'allow' }
  | {
      readonly kind: 'deny';
      readonly window: 'minute' | 'day';
      readonly retryAfterSeconds: number;
    };

export interface ChatRateLimiter {
  /**
   * トンネル経由の1回分を計上する。上限に達していれば deny を返し、そのときは
   * カウンタを増やさない。
   */
  consume(weight?: number): ChatRateLimitDecision;
}

export interface ChatRateLimiterOptions {
  readonly now: () => Date;
  readonly perMinute?: number;
  readonly perDay?: number;
}

function normalizeLimit(value: number | undefined, defaultValue: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return defaultValue;
  }
  return value;
}

function normalizeWeight(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return 1;
  }
  return value;
}

function windowRetryAfterSeconds(
  ms: number,
  windowMs: number,
): number {
  const elapsedInWindow = ms % windowMs;
  const remainingMs = windowMs - elapsedInWindow;
  return Math.max(1, Math.ceil(remainingMs / 1000));
}

export function createChatRateLimiter(
  options: ChatRateLimiterOptions,
): ChatRateLimiter {
  const perMinute = normalizeLimit(
    options.perMinute,
    DEFAULT_CHAT_RATE_LIMIT_PER_MINUTE,
  );
  const perDay = normalizeLimit(
    options.perDay,
    DEFAULT_CHAT_RATE_LIMIT_PER_DAY,
  );

  let minuteWindowIndex = -1;
  let minuteCount = 0;
  let dayWindowIndex = -1;
  let dayCount = 0;

  const resetWindowsIfNeeded = (ms: number): void => {
    const currentMinuteIndex = Math.floor(ms / MS_PER_MINUTE);
    if (currentMinuteIndex !== minuteWindowIndex) {
      minuteWindowIndex = currentMinuteIndex;
      minuteCount = 0;
    }

    const currentDayIndex = Math.floor(ms / MS_PER_DAY);
    if (currentDayIndex !== dayWindowIndex) {
      dayWindowIndex = currentDayIndex;
      dayCount = 0;
    }
  };

  return {
    consume(rawWeight?: number): ChatRateLimitDecision {
      const weight = normalizeWeight(rawWeight);
      const ms = options.now().getTime();
      resetWindowsIfNeeded(ms);

      if (dayCount + weight > perDay) {
        return {
          kind: 'deny',
          window: 'day',
          retryAfterSeconds: windowRetryAfterSeconds(ms, MS_PER_DAY),
        };
      }

      if (minuteCount + weight > perMinute) {
        return {
          kind: 'deny',
          window: 'minute',
          retryAfterSeconds: windowRetryAfterSeconds(ms, MS_PER_MINUTE),
        };
      }

      dayCount += weight;
      minuteCount += weight;
      return { kind: 'allow' };
    },
  };
}

export function rateLimitedResponse(
  c: Context,
  decision: Extract<ChatRateLimitDecision, { kind: 'deny' }>,
): Response {
  c.header('Retry-After', String(decision.retryAfterSeconds));
  return c.json({ error: CHAT_RATE_LIMITED }, 429);
}

/**
 * `exemptPaths`(完全一致 Set)では動的セグメント(例: adopt の :projectId/:sessionId)を
 * 表現できないので、メソッド+正規表現の組で免除するための型。104.12 で GET 専用の
 * `exemptGetPathPatterns` として着地したものを、bdboard-3tw.104.3 レビュー S1 で
 * メソッド非依存に一般化した(POST の adopt もここに乗せるため)。
 */
export interface ChatRateLimitExemptPattern {
  readonly method: string;
  readonly pattern: RegExp;
}

export interface ResolveChatRateLimitWeightArgs {
  readonly agentId: string | undefined;
  readonly model: string | undefined;
}

export function createChatRateLimitMiddleware(
  limiter: ChatRateLimiter,
  options?: {
    readonly exemptPaths?: readonly string[];
    readonly exemptPathPatterns?: readonly ChatRateLimitExemptPattern[];
    readonly defaultWeight?: number;
    readonly resolveWeight?: (args: ResolveChatRateLimitWeightArgs) => number;
  },
): MiddlewareHandler {
  const exemptPaths = new Set(options?.exemptPaths ?? []);
  const exemptPathPatterns = options?.exemptPathPatterns ?? [];
  const defaultWeight = options?.defaultWeight ?? DEFAULT_CHAT_RATE_LIMIT_WEIGHT;

  return async (c, next) => {
    if (isLocalControlRequest(c)) {
      await next();
      return;
    }

    // availability は CLI 起動の有無をハンドラ側で判定し、実際に起動したときだけ計上する。
    // ミドルウェアで一律に数えると UI のポーリングが枠を食い尽くすため除外する。
    // exemptPathPatterns の各免除理由(純SQLite読み取り・子プロセス無し等)は配線元
    // chat-routes.ts のコメントを参照。
    if (
      exemptPaths.has(c.req.path) ||
      exemptPathPatterns.some(
        (entry) => entry.method === c.req.method && entry.pattern.test(c.req.path),
      )
    ) {
      await next();
      return;
    }

    let weight = defaultWeight;
    if (c.req.method === 'POST') {
      let agentId: string | undefined;
      let model: string | undefined;
      try {
        const body: unknown = await c.req.json();
        if (typeof body === 'object' && body !== null) {
          const rawModel = (body as { model?: unknown }).model;
          model = typeof rawModel === 'string' ? rawModel : undefined;
          const rawAgentId = (body as { agentId?: unknown }).agentId;
          agentId = typeof rawAgentId === 'string' ? rawAgentId : undefined;
        }
      } catch {
        // JSON parse 失敗時は agentId/model とも undefined のまま resolveWeight に渡す。
      }
      weight = options?.resolveWeight?.({ agentId, model }) ?? defaultWeight;
    }

    const decision = limiter.consume(weight);
    if (decision.kind === 'deny') {
      return rateLimitedResponse(c, decision);
    }

    await next();
  };
}
