/**
 * agent run API 向けの固定窓レート制限 (bdboard-54be.1)。
 *
 * 固定窓カウンタ (`createChatRateLimiter`) はチャット固有の要素を持たない汎用実装なので再利用する。
 * 一方 `createChatRateLimitMiddleware` は POST ボディを JSON パースしてモデル重みを解決する
 * チャット固有の責務を抱えており、`rateLimitedResponse` が返す本文も `chat rate limit exceeded` で
 * 固定なので、そのままでは使えない。chat 側をリネーム/一般化するとチャットのルート・テストに
 * 広く波及して回帰リスクだけが増えるため、ここでは薄いミドルウェアを別に置いた (bdboard-54be.1)。
 */
import type { Context, MiddlewareHandler } from 'hono';
import {
  createChatRateLimiter,
  type ChatRateLimitDecision,
  type ChatRateLimiter,
} from './chat-rate-limit.js';
import { isLocalBasicAuthRequest } from './local-request.js';

export { createChatRateLimiter, type ChatRateLimiter };

export const AGENT_RUN_RATE_LIMITED = 'agent run rate limit exceeded';

/**
 * run 1 本は worktree 作成 + Claude CLI 起動 + `npm run verify` まで走る重い操作で、
 * `maxConcurrent` は既定 1。チャット (10/分・100/日) より厳しめの上限にする。
 */
export const DEFAULT_AGENT_RUN_RATE_LIMIT_PER_MINUTE = 5;
export const DEFAULT_AGENT_RUN_RATE_LIMIT_PER_DAY = 50;

export function agentRunRateLimitedResponse(
  c: Context,
  decision: Extract<ChatRateLimitDecision, { kind: 'deny' }>,
): Response {
  c.header('Retry-After', String(decision.retryAfterSeconds));
  return c.json({ error: AGENT_RUN_RATE_LIMITED }, 429);
}

export function createAgentRunRateLimitMiddleware(
  limiter: ChatRateLimiter,
): MiddlewareHandler {
  return async (c, next) => {
    // agent-run-guard.ts がリモート判定に使っている述語と同じものを使う。ここだけ別の述語にすると、
    // ガードは『ローカル扱い』なのにレート制限は『リモート扱い』のような食い違いが起きうる。
    if (isLocalBasicAuthRequest(c)) {
      await next();
      return;
    }

    // run のログ/一覧は UI がポーリングで GET する正常系であり、ここを数えると通常利用で枠を
    // 使い切ってしまう。高コストなのは run を起動する POST だけなので POST に限定する。
    if (c.req.method !== 'POST') {
      await next();
      return;
    }

    // チャットのミドルウェアと違いボディを読まない。後段の parseJsonBody がボディを消費済みに
    // されないように、そして無駄なパースを避けるため。
    const decision = limiter.consume(1);
    if (decision.kind === 'deny') {
      return agentRunRateLimitedResponse(c, decision);
    }

    await next();
  };
}
