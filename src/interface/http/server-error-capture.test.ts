/** bdboard-4y8q.6.4: API の 5xx と処理されなかった例外を本体エラーの下書きにする middleware と onError。 */
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SelfErrorReportOutcome, SelfErrorReporter } from '../../application/issue-report/self-error-reporter.js';
import { BdError } from '../../application/ports/issue-repository.js';
import { respondBdError } from './bd-error-response.js';
import { ERROR_DRAFT_HEADER, createServerErrorCapture, serverErrorHandler } from './server-error-capture.js';

type Report = SelfErrorReporter['report'];

function fakeReporter(outcome: SelfErrorReportOutcome = 'recorded') {
  const report = vi.fn<Report>().mockResolvedValue(outcome);
  return { reporter: { report }, report };
}

function buildApp(reporter: Pick<SelfErrorReporter, 'report'>): Hono {
  const app = new Hono();
  app.onError(serverErrorHandler);
  app.use('*', createServerErrorCapture({ reporter }));
  return app;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('app.onError (serverErrorHandler)', () => {
  it('answers a thrown error with a 500 JSON that has no stack or message, and still logs it with console.error', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const failure = new Error('secret message at /private/example-project');
    const app = new Hono();
    app.onError(serverErrorHandler);
    app.get('/api/boom', () => {
      throw failure;
    });
    const res = await app.request('/api/boom');
    expect(res.status).toBe(500);
    expect(res.headers.get('content-type')).toContain('application/json');
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: 'internal error' });
    expect(text).not.toContain('secret');
    expect(text).not.toContain('at ');
    expect(consoleError).toHaveBeenCalledWith(failure);
  });

  it('keeps an HTTPException response as it is, as the default Hono handler does', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const app = new Hono();
    app.onError(serverErrorHandler);
    app.get('/api/teapot', () => {
      throw new HTTPException(418, { message: 'short and stout' });
    });
    const res = await app.request('/api/teapot');
    expect(res.status).toBe(418);
    expect(await res.text()).toBe('short and stout');
    expect(consoleError).not.toHaveBeenCalled();
  });
});

describe('createServerErrorCapture', () => {
  it('reports a thrown handler error with the route pattern as source (no concrete id) and name, message and stack as text', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { reporter, report } = fakeReporter();
    const app = buildApp(reporter);
    app.get('/api/tickets/:id', () => {
      throw new TypeError('cannot read properties of undefined');
    });
    const res = await app.request('/api/tickets/bdboard-xyz9');
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'internal error' });
    expect(res.headers.get(ERROR_DRAFT_HEADER)).toBe('recorded');
    expect(report).toHaveBeenCalledTimes(1);
    const input = report.mock.calls[0]?.[0];
    expect(input?.source).toBe('api:GET /api/tickets/:id');
    expect(input?.source).not.toContain('xyz9');
    expect(input?.errorText).toContain('HTTP 500');
    expect(input?.errorText).toContain('TypeError: cannot read properties of undefined');
    expect(input?.errorText).toContain('server-error-capture.test.ts');
  });

  it('uses the route that answered, not the SPA-style catch-all registered after it', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { reporter, report } = fakeReporter();
    const app = buildApp(reporter);
    app.get('/api/tickets/:id{.+}', () => {
      throw new Error('boom');
    });
    app.get('*', (c) => c.html('<html></html>'));
    await app.request('/api/tickets/bdboard-xyz9');
    expect(report.mock.calls[0]?.[0].source).toBe('api:GET /api/tickets/:id{.+}');
  });

  it('keeps the detail of a respondBdError 502 in the text (error label and detail)', async () => {
    const { reporter, report } = fakeReporter();
    const app = buildApp(reporter);
    app.get('/api/board', (c) =>
      respondBdError(c, 'failed to read board', new BdError('unknown', 'p', 'database "epic_haslett_00ae14" not found on dolt server')),
    );
    const res = await app.request('/api/board');
    expect(res.status).toBe(502);
    // 応答の本文は複製から読むので、元の応答はそのまま読める。
    expect(await res.json()).toEqual({ error: 'failed to read board', detail: 'database "epic_haslett_00ae14" not found on dolt server' });
    expect(res.headers.get(ERROR_DRAFT_HEADER)).toBe('recorded');
    expect(report.mock.calls[0]?.[0]).toEqual({
      source: 'api:GET /api/board',
      errorText: 'HTTP 502\nerror: failed to read board\ndetail: database "epic_haslett_00ae14" not found on dolt server',
    });
  });

  it('does not report 4xx, 501 and 507, and does not add the header to a non-5xx response', async () => {
    const { reporter, report } = fakeReporter();
    const app = buildApp(reporter);
    app.get('/api/not-found', (c) => c.json({ error: 'not found' }, 404));
    app.get('/api/unsupported', (c) => c.json({ error: 'comments not available' }, 501));
    app.get('/api/full', (c) => c.json({ error: 'issue draft storage is full' }, 507));
    app.get('/api/fine', (c) => c.json({ ok: true }));
    const notFound = await app.request('/api/not-found');
    const fine = await app.request('/api/fine');
    expect(notFound.headers.get(ERROR_DRAFT_HEADER)).toBeNull();
    expect(fine.headers.get(ERROR_DRAFT_HEADER)).toBeNull();
    for (const path of ['/api/unsupported', '/api/full']) {
      const res = await app.request(path);
      expect(res.headers.get(ERROR_DRAFT_HEADER)).toBe('skipped');
    }
    expect(report).not.toHaveBeenCalled();
  });

  it('does not report failures under /api/issue-reports (no recursion into the intake)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { reporter, report } = fakeReporter();
    const app = buildApp(reporter);
    app.post('/api/issue-reports', (c) => c.json({ error: 'failed' }, 500));
    app.get('/api/issue-reports/drafts/:id', () => {
      throw new Error('boom');
    });
    for (const [method, path] of [['POST', '/api/issue-reports'], ['GET', '/api/issue-reports/drafts/abc']] as const) {
      const res = await app.request(path, { method });
      expect(res.status).toBe(500);
      expect(res.headers.get(ERROR_DRAFT_HEADER)).toBe('skipped');
    }
    expect(report).not.toHaveBeenCalled();
  });

  it('leaves an SSE response alone (no header, the stream is delivered whole)', async () => {
    const { reporter, report } = fakeReporter();
    const app = buildApp(reporter);
    app.get('/api/events', () => {
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('event: one\ndata: 1\n\n'));
          controller.enqueue(encoder.encode('event: two\ndata: 2\n\n'));
          controller.close();
        },
      });
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    });
    app.get('/api/events-failed', () => new Response('event: error\ndata: {}\n\n', { status: 503, headers: { 'content-type': 'text/event-stream' } }));
    const ok = await app.request('/api/events');
    expect(ok.headers.get(ERROR_DRAFT_HEADER)).toBeNull();
    expect(await ok.text()).toBe('event: one\ndata: 1\n\nevent: two\ndata: 2\n\n');
    const failed = await app.request('/api/events-failed');
    expect(failed.status).toBe(503);
    expect(failed.headers.get(ERROR_DRAFT_HEADER)).toBeNull();
    expect(await failed.text()).toBe('event: error\ndata: {}\n\n');
    expect(report).not.toHaveBeenCalled();
  });

  it('takes only the status and the error label under /api/tunnel and /api/chat (never the body or the exception text)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { reporter, report } = fakeReporter();
    const app = buildApp(reporter);
    app.post('/api/tunnel/start', (c) =>
      c.json({ error: 'tunnel start failed', detail: 'https://example-tunnel.trycloudflare.com token=example-secret' }, 500),
    );
    app.post('/api/tunnel/leaky', (c) => c.json({ error: 'failed at https://example-tunnel.trycloudflare.com/x' }, 500));
    app.post('/api/chat/threads', () => {
      throw new RangeError('transcript: example-secret conversation');
    });
    app.post('/api/chat/messages', (c) => c.json({ error: 'chat failed', code: 'agent-error', detail: 'example-secret prompt' }, 502));
    for (const path of ['/api/tunnel/start', '/api/tunnel/leaky', '/api/chat/threads', '/api/chat/messages']) {
      await app.request(path, { method: 'POST' });
    }
    expect(report.mock.calls.map(([input]) => input)).toEqual([
      { source: 'api:POST /api/tunnel/start', errorText: 'HTTP 500\nerror: tunnel start failed' },
      { source: 'api:POST /api/tunnel/leaky', errorText: 'HTTP 500' },
      { source: 'api:POST /api/chat/threads', errorText: 'HTTP 500\nRangeError' },
      { source: 'api:POST /api/chat/messages', errorText: 'HTTP 502\nerror: chat failed' },
    ]);
    expect(JSON.stringify(report.mock.calls)).not.toContain('example-secret');
  });

  it('does not read a body over 16KB, a non-JSON body or a broken JSON body', async () => {
    const { reporter, report } = fakeReporter();
    const app = buildApp(reporter);
    app.get('/api/big', (c) => c.json({ error: 'big', detail: 'x'.repeat(20_000) }, 500));
    app.get('/api/text', (c) => c.text('plain failure text', 500));
    app.get('/api/broken', (c) => new Response('{"error": ', { status: 500, headers: { 'content-type': 'application/json' } }));
    for (const path of ['/api/big', '/api/text', '/api/broken']) {
      const res = await app.request(path);
      expect(res.status).toBe(500);
    }
    expect(report.mock.calls.map(([input]) => input.errorText)).toEqual(['HTTP 500', 'HTTP 500', 'HTTP 500']);
    // 大きな本文も、複製を読んだあとの元の応答は壊れない。
    const again = await app.request('/api/big');
    expect(((await again.json()) as { detail: string }).detail).toHaveLength(20_000);
  });

  it('answers a non-Error throw with the same 500 JSON and reports it', async () => {
    const { reporter, report } = fakeReporter();
    const app = buildApp(reporter);
    app.get('/api/string-throw', () => {
      throw 'a plain string with example-secret';
    });
    const res = await app.request('/api/string-throw');
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'internal error' });
    expect(res.headers.get(ERROR_DRAFT_HEADER)).toBe('recorded');
    expect(report.mock.calls[0]?.[0]).toEqual({ source: 'api:GET /api/string-throw', errorText: 'HTTP 500\nnon-Error value thrown' });
  });

  it.each<SelfErrorReportOutcome>(['recorded', 'throttled', 'skipped'])('passes the reporter outcome %s through as the header', async (outcome) => {
    const { reporter } = fakeReporter(outcome);
    const app = buildApp(reporter);
    app.get('/api/fail', (c) => c.json({ error: 'failed' }, 500));
    const res = await app.request('/api/fail');
    expect(res.headers.get(ERROR_DRAFT_HEADER)).toBe(outcome);
    expect(await res.json()).toEqual({ error: 'failed' });
  });

  it('keeps the response as it is when the reporter rejects (header skipped)', async () => {
    const report = vi.fn<Report>().mockRejectedValue(new Error('storage broke'));
    const app = buildApp({ report });
    app.get('/api/fail', (c) => c.json({ error: 'failed' }, 500));
    const res = await app.request('/api/fail');
    expect(res.status).toBe(500);
    expect(res.headers.get(ERROR_DRAFT_HEADER)).toBe('skipped');
    expect(await res.json()).toEqual({ error: 'failed' });
  });

  it('does not hold the error response for a reporter that never answers (header skipped after 2 seconds)', async () => {
    vi.useFakeTimers();
    const report = vi.fn<Report>().mockReturnValue(new Promise<SelfErrorReportOutcome>(() => undefined));
    const app = buildApp({ report });
    app.get('/api/fail', (c) => c.json({ error: 'failed' }, 500));
    const pending = app.request('/api/fail');
    await vi.advanceTimersByTimeAsync(2_000);
    const res = await pending;
    expect(res.status).toBe(500);
    expect(res.headers.get(ERROR_DRAFT_HEADER)).toBe('skipped');
  });
});
