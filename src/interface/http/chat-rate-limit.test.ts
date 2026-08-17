import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CHAT_RATE_LIMIT_PER_DAY,
  DEFAULT_CHAT_RATE_LIMIT_PER_MINUTE,
  createChatRateLimiter,
  createChatRateLimitMiddleware,
} from './chat-rate-limit.js';

describe('createChatRateLimiter', () => {
  it('allows requests within both limits', () => {
    let currentMs = 0;
    const limiter = createChatRateLimiter({
      now: () => new Date(currentMs),
      perMinute: 3,
      perDay: 10,
    });

    for (let i = 0; i < 3; i += 1) {
      expect(limiter.consume()).toEqual({ kind: 'allow' });
    }
  });

  it('denies when per-minute limit is exceeded without incrementing the counter', () => {
    let currentMs = 0;
    const limiter = createChatRateLimiter({
      now: () => new Date(currentMs),
      perMinute: 2,
      perDay: 100,
    });

    expect(limiter.consume()).toEqual({ kind: 'allow' });
    expect(limiter.consume()).toEqual({ kind: 'allow' });

    const denied = limiter.consume();
    expect(denied.kind).toBe('deny');
    if (denied.kind === 'deny') {
      expect(denied.window).toBe('minute');
    }

    currentMs += 61_000;

    expect(limiter.consume()).toEqual({ kind: 'allow' });
    expect(limiter.consume()).toEqual({ kind: 'allow' });
    expect(limiter.consume().kind).toBe('deny');
  });

  it('resets the minute window after it elapses', () => {
    let currentMs = 30_000;
    const limiter = createChatRateLimiter({
      now: () => new Date(currentMs),
      perMinute: 1,
      perDay: 100,
    });

    expect(limiter.consume()).toEqual({ kind: 'allow' });
    expect(limiter.consume().kind).toBe('deny');

    currentMs += 31_000;

    expect(limiter.consume()).toEqual({ kind: 'allow' });
  });

  it('keeps denying after the minute window when the daily limit is reached', () => {
    let currentMs = 0;
    const limiter = createChatRateLimiter({
      now: () => new Date(currentMs),
      perMinute: 10,
      perDay: 2,
    });

    expect(limiter.consume()).toEqual({ kind: 'allow' });
    expect(limiter.consume()).toEqual({ kind: 'allow' });
    expect(limiter.consume().kind).toBe('deny');

    currentMs += 61_000;

    expect(limiter.consume().kind).toBe('deny');
  });

  it('reports retryAfterSeconds as remaining time in the window', () => {
    let currentMs = 10_500;
    const limiter = createChatRateLimiter({
      now: () => new Date(currentMs),
      perMinute: 1,
      perDay: 100,
    });

    expect(limiter.consume()).toEqual({ kind: 'allow' });

    const denied = limiter.consume();
    expect(denied).toEqual({
      kind: 'deny',
      window: 'minute',
      retryAfterSeconds: 50,
    });

    currentMs = 50_000;
    const dayLimiter = createChatRateLimiter({
      now: () => new Date(currentMs),
      perMinute: 100,
      perDay: 1,
    });

    expect(dayLimiter.consume()).toEqual({ kind: 'allow' });
    expect(dayLimiter.consume()).toEqual({
      kind: 'deny',
      window: 'day',
      retryAfterSeconds: 86_350,
    });
  });

  it('falls back to defaults for non-positive or NaN limits', () => {
    const limiter = createChatRateLimiter({
      now: () => new Date(0),
      perMinute: 0,
      perDay: Number.NaN,
    });

    for (let i = 0; i < DEFAULT_CHAT_RATE_LIMIT_PER_MINUTE; i += 1) {
      expect(limiter.consume()).toEqual({ kind: 'allow' });
    }
    expect(limiter.consume().kind).toBe('deny');

    let currentMs = 0;
    const dayLimiter = createChatRateLimiter({
      now: () => new Date(currentMs),
      perMinute: 10_000,
      perDay: -1,
    });

    for (let i = 0; i < DEFAULT_CHAT_RATE_LIMIT_PER_DAY; i += 1) {
      expect(dayLimiter.consume()).toEqual({ kind: 'allow' });
    }
    expect(dayLimiter.consume().kind).toBe('deny');
  });

  it('allows a weighted request that exactly uses the minute and day budgets', () => {
    const limiter = createChatRateLimiter({
      now: () => new Date(0),
      perMinute: 2,
      perDay: 2,
    });

    expect(limiter.consume(1.25)).toEqual({ kind: 'allow' });
    expect(limiter.consume(0.75)).toEqual({ kind: 'allow' });
    expect(limiter.consume(0.01).kind).toBe('deny');
  });

  it('does not increment counters when a weighted request is denied', () => {
    const limiter = createChatRateLimiter({
      now: () => new Date(0),
      perMinute: 2,
      perDay: 2,
    });

    expect(limiter.consume(1.5)).toEqual({ kind: 'allow' });
    expect(limiter.consume(0.75).kind).toBe('deny');
    expect(limiter.consume(0.5)).toEqual({ kind: 'allow' });
  });

  it('supports fractional weights and defaults omitted or invalid weights to one', () => {
    const limiter = createChatRateLimiter({
      now: () => new Date(0),
      perMinute: 2,
      perDay: 2,
    });

    for (let i = 0; i < 4; i += 1) {
      expect(limiter.consume(0.25)).toEqual({ kind: 'allow' });
    }
    expect(limiter.consume()).toEqual({ kind: 'allow' });
    expect(limiter.consume(0).kind).toBe('deny');
    expect(limiter.consume(-1).kind).toBe('deny');
    expect(limiter.consume(Number.NaN).kind).toBe('deny');
    expect(limiter.consume(Number.POSITIVE_INFINITY).kind).toBe('deny');
  });
});

describe('createChatRateLimitMiddleware', () => {
  function createTestApp(
    perDay = 100,
    resolveWeight?: (args: { agentId: string | undefined; model: string | undefined }) => number,
  ) {
    const limiter = createChatRateLimiter({
      now: () => new Date(0),
      perMinute: 100,
      perDay,
    });
    const app = new Hono();
    app.use('/api/chat/*', createChatRateLimitMiddleware(limiter, {
      resolveWeight,
    }));
    app.all('/api/chat/*', async (c) => {
      if (c.req.method !== 'POST') {
        return c.text('ok');
      }
      try {
        return c.json(await c.req.json());
      } catch {
        return c.text('ok');
      }
    });
    return app;
  }

  async function request(
    app: Hono,
    method: string,
    body?: string,
  ): Promise<Response> {
    return app.fetch(
      new Request('http://localhost/api/chat/message', {
        method,
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body,
      }),
      { incoming: { socket: { remoteAddress: '192.0.2.1' } } },
    );
  }

  it('charges opus more than sonnet', async () => {
    const weightOf = ({ model }: { model: string | undefined }) => (model === 'opus' ? 5 : 1);
    const opusApp = createTestApp(4, weightOf);
    expect((await request(opusApp, 'POST', JSON.stringify({ model: 'opus' }))).status).toBe(429);

    const sonnetApp = createTestApp(4, weightOf);
    expect((await request(sonnetApp, 'POST', JSON.stringify({ model: 'sonnet' }))).status).toBe(200);
    expect((await request(sonnetApp, 'POST', JSON.stringify({ model: 'sonnet' }))).status).toBe(200);
  });

  it('uses the default weight for model-less POST and GET requests', async () => {
    const app = createTestApp(2);
    const body = { message: 'hello' };
    const post = await request(app, 'POST', JSON.stringify(body));
    expect(post.status).toBe(200);
    expect(await post.json()).toEqual(body);
    expect((await request(app, 'GET'))).toHaveProperty('status', 200);
    expect((await request(app, 'GET'))).toHaveProperty('status', 429);
  });

  it('charges the resolved default model when model is omitted', async () => {
    const app = createTestApp(5, ({ agentId }) => (agentId === 'opus-agent' ? 5 : 1));

    expect(
      (await request(app, 'POST', JSON.stringify({ agentId: 'opus-agent' }))).status,
    ).toBe(200);
    expect(
      (await request(app, 'POST', JSON.stringify({ agentId: 'opus-agent' }))).status,
    ).toBe(429);
  });

  it('continues after invalid JSON and charges the default weight', async () => {
    const app = createTestApp(1);
    expect((await request(app, 'POST', '{'))).toHaveProperty('status', 200);
    expect((await request(app, 'GET'))).toHaveProperty('status', 429);
  });

  it('exempts matching GET paths without exempting other methods or paths', async () => {
    const limiter = createChatRateLimiter({
      now: () => new Date(0),
      perMinute: 2,
      perDay: 100,
    });
    const app = new Hono();
    app.use('/api/chat/*', createChatRateLimitMiddleware(limiter, {
      exemptPathPatterns: [
        { method: 'GET', pattern: /^\/api\/chat\/sessions\/[^/]+\/messages$/ },
      ],
    }));
    app.all('/api/chat/*', (c) => c.text('ok'));

    const requestPath = async (path: string, method: string): Promise<Response> =>
      app.fetch(
        new Request(`http://localhost${path}`, { method }),
        { incoming: { socket: { remoteAddress: '192.0.2.1' } } },
      );

    for (let i = 0; i < 5; i += 1) {
      expect((await requestPath('/api/chat/sessions/session-1/messages', 'GET')).status).toBe(200);
    }
    expect((await requestPath('/api/chat/sessions/session-1/messages', 'POST')).status).toBe(200);
    expect((await requestPath('/api/chat/sessions/session-1/messages', 'POST')).status).toBe(200);
    expect((await requestPath('/api/chat/other', 'GET')).status).toBe(429);
  });

  // bdboard-3tw.104.3 レビュー n9 → S1: adopt は子プロセスを起こさないので、トンネル経由でも
  // レート制限のコスト計上から除外する。exemptPaths(完全一致 Set)では動的セグメントを
  // 表現できないため、メソッド+正規表現の exemptPathPatterns(104.12 の GET専用
  // exemptGetPathPatterns をメソッド非依存に一般化したもの)で POST も免除できることを固定する。
  it('exempts paths matched by a POST exemptPathPatterns entry without charging the rate limit budget', async () => {
    const limiter = createChatRateLimiter({
      now: () => new Date(0),
      perMinute: 1,
      perDay: 1,
    });
    const app = new Hono();
    app.use(
      '/api/chat/*',
      createChatRateLimitMiddleware(limiter, {
        exemptPathPatterns: [{ method: 'POST', pattern: /\/adopt$/ }],
      }),
    );
    app.all('/api/chat/*', (c) => c.text('ok'));

    const remote = { incoming: { socket: { remoteAddress: '192.0.2.1' } } };
    const adoptPath = '/api/chat/projects/p1/discovered-sessions/s1/adopt';

    // perMinute=1 の枠を adopt では何回呼んでも消費しない。
    for (let i = 0; i < 3; i += 1) {
      const res = await app.fetch(
        new Request(`http://localhost${adoptPath}`, { method: 'POST' }),
        remote,
      );
      expect(res.status).toBe(200);
    }

    // GET は免除対象に含めていないので、同じパスでも method が違えば免除されない。
    expect(
      (await app.fetch(new Request(`http://localhost${adoptPath}`, { method: 'GET' }), remote)).status,
    ).toBe(200);
    expect(
      (await app.fetch(new Request(`http://localhost${adoptPath}`, { method: 'GET' }), remote)).status,
    ).toBe(429);
  });
});
