import type { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { EMPTY_LIST, type ExternalIssueList } from '../../application/issue-report/external-issue-list.js';
import { createHarness, makeIssue, withBody } from '../../application/issue-report/external-issue-test-support.js';
import { createExternalIssueRoutes, EXTERNAL_ISSUES_PATH, EXTERNAL_ISSUES_REFRESH_PATH } from './external-issue-routes.js';

/** bdboard-4y8q.9.4: GET /api/issue-reports/external と POST /api/issue-reports/external/refresh。 */

const LOCAL_ENV = { incoming: { socket: { remoteAddress: '127.0.0.1', localPort: 8787 } } };
// cloudflared はローカルのサーバーへ 127.0.0.1 から繋ぐので、送信元だけではトンネルと見分けがつかない (cf-* ヘッダーで見分ける)。
const TUNNEL_ENV = LOCAL_ENV;
const REMOTE_ENV = { incoming: { socket: { remoteAddress: '192.0.2.1', localPort: 8787 } } };
const LOCAL_HOST = 'localhost:8787';
const CF_HEADERS = { 'cf-ray': 'abc123-NRT', 'cf-connecting-ip': '203.0.113.9' } as const;

const DISABLED_BODY = {
  enabled: false,
  state: 'idle',
  fetchedAt: null,
  error: null,
  truncated: false,
  skippedLines: 0,
  issues: [],
};

function fakeService(list: ExternalIssueList = EMPTY_LIST) {
  return {
    getList: vi.fn<() => ExternalIssueList>(() => list),
    poll: vi.fn<() => Promise<ExternalIssueList>>(() => Promise.resolve(list)),
  };
}

function setup(options: { list?: ExternalIssueList; refreshMinGapMs?: number } = {}) {
  let nowMs = 0;
  const service = fakeService(options.list);
  const app = createExternalIssueRoutes({
    service,
    now: () => nowMs,
    ...(options.refreshMinGapMs !== undefined ? { refreshMinGapMs: options.refreshMinGapMs } : {}),
  });
  return {
    app,
    service,
    advance(ms: number) {
      nowMs += ms;
    },
  };
}

const postInit = (headers: Record<string, string> = {}): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', host: LOCAL_HOST, ...headers },
  body: '{}',
});

const refresh = (app: Hono, headers: Record<string, string> = {}, env: unknown = LOCAL_ENV) =>
  app.request(EXTERNAL_ISSUES_REFRESH_PATH, postInit(headers), env);

const read = (app: Hono, headers: Record<string, string> = {}, env: unknown = LOCAL_ENV) =>
  app.request(EXTERNAL_ISSUES_PATH, { headers }, env);

/** 本物のサービス (偽のポート) で、一覧を 1 回読んだ状態を作る。 */
async function polledHarness(initial = [makeIssue(7, { title: 'Board hangs', body: 'it froze', bodyLength: 8 })]) {
  const harness = createHarness(initial);
  await harness.service.poll();
  return harness;
}

describe('GET /api/issue-reports/external: when incoming issues are not enabled', () => {
  it('answers with the fixed disabled shape and never asks a service for anything', async () => {
    const app = createExternalIssueRoutes({ service: undefined });
    const res = await read(app);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(DISABLED_BODY);
  });

  it('still answers a tunnel reader with the same shape', async () => {
    const app = createExternalIssueRoutes({ service: undefined });
    const res = await read(app, CF_HEADERS, TUNNEL_ENV);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(DISABLED_BODY);
  });
});

describe('GET /api/issue-reports/external: the list', () => {
  it('says enabled and idle before the first check, with an empty list', async () => {
    const { app } = setup();
    expect(await (await read(app)).json()).toEqual({
      enabled: true,
      state: 'idle',
      fetchedAt: null,
      error: null,
      truncated: false,
      skippedLines: 0,
      issues: [],
    });
  });

  it('gives each issue exactly the fields the ticket lists, copied one by one', async () => {
    const harness = await polledHarness([
      makeIssue(7, { title: 'Board hangs', body: 'see https://example.com/x', bodyLength: 25, author: 'example-reporter', authorAssociation: 'FIRST_TIME_CONTRIBUTOR' }),
    ]);
    const { app } = setup({ list: harness.service.getList() });

    const body = (await (await read(app)).json()) as { issues: Record<string, unknown>[] };

    expect(body.issues).toHaveLength(1);
    const [issue] = body.issues;
    // キーの集合を固定する: 内部の欄 (snapshot の入れ子・missingSince など) が API に漏れない。
    expect(Object.keys(issue ?? {}).sort()).toEqual(
      [
        'number',
        'title',
        'body',
        'author',
        'authorAssociation',
        'url',
        'updatedAt',
        'titleTruncated',
        'bodyTruncated',
        'titleLength',
        'bodyLength',
        'checks',
        'snapshotAt',
        'needsRejudge',
        'updatedAtChanged',
      ].sort(),
    );
    expect(issue).toMatchObject({
      number: 7,
      title: 'Board hangs',
      body: 'see https://example.com/x',
      author: 'example-reporter',
      authorAssociation: 'FIRST_TIME_CONTRIBUTOR',
      url: 'https://github.com/xiaotiantakumi/bdboard/issues/7',
      updatedAt: '2026-10-05T00:00:00Z',
      titleTruncated: false,
      bodyTruncated: false,
      titleLength: 11,
      bodyLength: 25,
      snapshotAt: harness.nowIso(),
      needsRejudge: false,
      updatedAtChanged: false,
    });
    // 機械の検査の結果は、判断を足さずにそのまま出る (リンクの数が 1)。
    expect(issue?.checks).toEqual(harness.service.getList().issues[0]?.checks);
    expect((issue?.checks as { body: { links: { total: number } } }).body.links.total).toBe(1);
  });

  it('keeps the list-level fields: fetchedAt, truncated and skippedLines', async () => {
    const harness = createHarness([makeIssue(1)]);
    harness.setIssues([makeIssue(1)], { truncatedByPageLimit: true, skippedLines: 2 });
    await harness.service.poll();
    const { app } = setup({ list: harness.service.getList() });

    expect(await (await read(app)).json()).toMatchObject({
      enabled: true,
      state: 'ok',
      fetchedAt: harness.nowIso(),
      error: null,
      truncated: true,
      skippedLines: 2,
    });
  });

  it('puts the written-over mark on needsRejudge and the changed updatedAt on updatedAtChanged, as the service reports them', async () => {
    const harness = await polledHarness([withBody(7, 'original text')]);
    // 本文だけ書き換えられた (updatedAt は進む)。
    harness.setIssues([withBody(7, 'edited text', { updatedAt: '2026-10-06T00:00:00Z' }), withBody(8, 'other')]);
    await harness.service.poll();
    const { app } = setup({ list: harness.service.getList() });

    const body = (await (await read(app)).json()) as { issues: { number: number; needsRejudge: boolean; updatedAtChanged: boolean; body: string; updatedAt: string }[] };

    // 現在の本文は新しい文章で、写しと違うので印が立つ。新しい issue (8) には立たない。
    expect(body.issues.map(({ number, needsRejudge, updatedAtChanged }) => ({ number, needsRejudge, updatedAtChanged }))).toEqual([
      { number: 7, needsRejudge: true, updatedAtChanged: true },
      { number: 8, needsRejudge: false, updatedAtChanged: false },
    ]);
    expect(body.issues[0]).toMatchObject({ body: 'edited text', updatedAt: '2026-10-06T00:00:00Z' });
  });

  it('does not put the mark on a change of updatedAt alone (a comment or a label)', async () => {
    const harness = await polledHarness([withBody(7, 'same text')]);
    harness.setIssues([withBody(7, 'same text', { updatedAt: '2026-10-06T00:00:00Z' })]);
    await harness.service.poll();
    const { app } = setup({ list: harness.service.getList() });

    const body = (await (await read(app)).json()) as { issues: { needsRejudge: boolean; updatedAtChanged: boolean }[] };

    expect(body.issues[0]).toMatchObject({ needsRejudge: false, updatedAtChanged: true });
  });

  it('shows a stopped check with the last good list and the fixed reason', async () => {
    const harness = await polledHarness();
    const good = harness.service.getList();
    const stopped: ExternalIssueList = { ...good, state: 'error', error: { kind: 'rate-limited', detail: 'gh rate limit' } };
    const { app } = setup({ list: stopped });

    const body = (await (await read(app)).json()) as { state: string; error: unknown; fetchedAt: string; issues: unknown[] };

    expect(body).toMatchObject({ state: 'error', error: { kind: 'rate-limited', detail: 'gh rate limit' }, fetchedAt: good.fetchedAt });
    expect(body.issues).toHaveLength(1);
  });

  it('returns third-party text only as JSON data, whatever it contains', async () => {
    const hostile = '</script><img src=x onerror=alert(1)>\n"quoted" \\ back-slash';
    const harness = await polledHarness([withBody(7, hostile, { title: '<b>t</b>' })]);
    const { app } = setup({ list: harness.service.getList() });

    const res = await read(app);

    expect(res.headers.get('content-type')).toContain('application/json');
    const body = (await res.json()) as { issues: { title: string; body: string }[] };
    expect(body.issues[0]?.title).toBe('<b>t</b>');
    expect(body.issues[0]?.body).toBe(hostile);
  });
});

describe('GET /api/issue-reports/external: reading never starts a check', () => {
  it('asks the service only for the list it already has: fifty reads start no poll, so no gh call', async () => {
    const harness = await polledHarness();
    const ghCallsBefore = harness.source.listOpenIssues.mock.calls.length;
    const app = createExternalIssueRoutes({ service: harness.service });

    for (let read_ = 0; read_ < 50; read_ += 1) {
      expect((await read(app)).status).toBe(200);
    }

    expect(harness.source.listOpenIssues.mock.calls.length).toBe(ghCallsBefore);
    expect(harness.refReader.listExternalRefs).toHaveBeenCalledTimes(ghCallsBefore);
  });

  it('is not held back by the refresh interval', async () => {
    const { app, service } = setup();
    expect((await refresh(app)).status).toBe(200);
    expect((await refresh(app)).status).toBe(429);

    expect((await read(app)).status).toBe(200);
    expect(service.poll).toHaveBeenCalledTimes(1);
  });
});

describe('GET /api/issue-reports/external: who can read', () => {
  it.each([
    ['the local machine', {}, LOCAL_ENV],
    ['a cloudflared tunnel (cf-ray)', CF_HEADERS, TUNNEL_ENV],
    ['only a cf-connecting-ip header', { 'cf-connecting-ip': '203.0.113.9' }, TUNNEL_ENV],
    ['a non-loopback source (behind the tunnel auth)', { host: 'board.example.test' }, REMOTE_ENV],
  ])('is readable from %s (reads sit outside the local-only guard; the tunnel auth covers them)', async (_label, headers, env) => {
    const { app } = setup();
    const res = await read(app, headers, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ enabled: true, state: 'idle' });
  });
});

describe('POST /api/issue-reports/external/refresh: not enabled', () => {
  it('answers 404 with a fixed code, from the local machine only', async () => {
    const app = createExternalIssueRoutes({ service: undefined });

    const res = await refresh(app);

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: 'incoming issues are not enabled in this environment',
      code: 'external-issues-disabled',
    });
    // 何度送っても 404 (枠を使い果たして 429 に変わらない)。
    expect((await refresh(app)).status).toBe(404);
  });

  it('still refuses the tunnel with 403 before it says anything about being disabled', async () => {
    const app = createExternalIssueRoutes({ service: undefined });
    const res = await refresh(app, CF_HEADERS, TUNNEL_ENV);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'local access only' });
  });
});

describe('POST /api/issue-reports/external/refresh: local direct access only', () => {
  it.each([
    ['a cf-ray header (cloudflared forwards from 127.0.0.1)', CF_HEADERS, TUNNEL_ENV],
    ['only a cf-connecting-ip header', { 'cf-connecting-ip': '203.0.113.9' }, TUNNEL_ENV],
    ['only a cf-visitor header', { 'cf-visitor': '{"scheme":"https"}' }, TUNNEL_ENV],
    ['a non-loopback TCP source', {}, REMOTE_ENV],
    ['a Host header that is not loopback (DNS rebinding)', { host: 'attacker.example:8787' }, LOCAL_ENV],
    ['no socket information at all', {}, {}],
  ])('rejects %s with 403, starts no check and keeps the refresh interval free', async (_label, headers, env) => {
    const { app, service } = setup();

    const res = await refresh(app, headers, env);

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'local access only' });
    expect(service.poll).not.toHaveBeenCalled();
    // 断られた要求は枠を使わない: そのあとのローカルの要求がすぐ通る。
    expect((await refresh(app)).status).toBe(200);
  });

  it('rejects a cross-site POST and a form-typed POST from the local machine (the CSRF layers stay on)', async () => {
    const { app, service } = setup();

    const crossSite = await refresh(app, { 'sec-fetch-site': 'cross-site' });
    const form = await app.request(
      EXTERNAL_ISSUES_REFRESH_PATH,
      { method: 'POST', headers: { 'content-type': 'text/plain', host: LOCAL_HOST }, body: '{}' },
      LOCAL_ENV,
    );

    expect(crossSite.status).toBe(403);
    expect(await crossSite.json()).toEqual({ error: 'cross-site write blocked' });
    expect(form.status).toBe(403);
    expect(service.poll).not.toHaveBeenCalled();
    expect((await refresh(app)).status).toBe(200);
  });

  it('does not accept GET or PUT on the refresh path as a refresh', async () => {
    const { app, service } = setup();
    expect((await app.request(EXTERNAL_ISSUES_REFRESH_PATH, { headers: { host: LOCAL_HOST } }, LOCAL_ENV)).status).toBe(404);
    expect((await app.request(EXTERNAL_ISSUES_REFRESH_PATH, { ...postInit(), method: 'PUT' }, LOCAL_ENV)).status).toBe(404);
    expect(service.poll).not.toHaveBeenCalled();
  });
});

describe('POST /api/issue-reports/external/refresh: the check and the once-a-minute limit', () => {
  it('starts one check and answers with the list it produced', async () => {
    const harness = await polledHarness();
    const good = harness.service.getList();
    const { app, service } = setup({ list: good });

    const res = await refresh(app);

    expect(res.status).toBe(200);
    expect(service.poll).toHaveBeenCalledTimes(1);
    expect(await res.json()).toEqual(await (await read(app)).json());
  });

  it('answers 429 with Retry-After for a second request inside a minute, and starts no check for it', async () => {
    const { app, service, advance } = setup();
    expect((await refresh(app)).status).toBe(200);

    advance(1);
    const refused = await refresh(app);

    expect(refused.status).toBe(429);
    expect(refused.headers.get('retry-after')).toBe('60');
    expect(await refused.json()).toEqual({
      error: 'refresh is limited to once per minute',
      code: 'refresh-rate-limited',
      retryAfterSeconds: 60,
    });
    expect(service.poll).toHaveBeenCalledTimes(1);
  });

  it('counts down in Retry-After, never below one second', async () => {
    const { app, advance } = setup();
    await refresh(app);

    advance(30_000);
    expect((await refresh(app)).headers.get('retry-after')).toBe('30');
    advance(29_001);
    expect((await refresh(app)).headers.get('retry-after')).toBe('1');
  });

  it('lets a request through at 60 seconds and not a millisecond before', async () => {
    const { app, service, advance } = setup();
    expect((await refresh(app)).status).toBe(200);

    advance(59_999);
    expect((await refresh(app)).status).toBe(429);
    advance(1);
    expect((await refresh(app)).status).toBe(200);
    expect(service.poll).toHaveBeenCalledTimes(2);
  });

  it('does not push the next chance back when a request is refused: hammering still ends at 60 seconds after the last accepted one', async () => {
    const { app, service, advance } = setup();
    await refresh(app);

    for (let second = 0; second < 59; second += 1) {
      advance(1000);
      expect((await refresh(app)).status).toBe(429);
    }
    advance(1000);

    expect((await refresh(app)).status).toBe(200);
    expect(service.poll).toHaveBeenCalledTimes(2);
  });

  it('lets only one of two simultaneous requests start a check', async () => {
    const { app, service } = setup();

    const [first, second] = await Promise.all([refresh(app), refresh(app)]);

    expect([first.status, second.status].sort()).toEqual([200, 429]);
    expect(service.poll).toHaveBeenCalledTimes(1);
  });

  it('answers 200 with the stopped state when the check ends in an error (the failure is in the body, not in the status)', async () => {
    const stopped: ExternalIssueList = { ...EMPTY_LIST, state: 'error', error: { kind: 'failed', detail: 'gh timed out' } };
    const { app } = setup({ list: stopped });

    const res = await refresh(app);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ enabled: true, state: 'error', error: { kind: 'failed', detail: 'gh timed out' } });
  });

  it('uses the interval it was given', async () => {
    const { app, advance } = setup({ refreshMinGapMs: 5000 });
    await refresh(app);
    advance(4999);
    expect((await refresh(app)).status).toBe(429);
    advance(1);
    expect((await refresh(app)).status).toBe(200);
  });

  it('keeps one interval for the router: a second router has its own (each router owns its gate)', async () => {
    const first = setup();
    const second = setup();
    expect((await refresh(first.app)).status).toBe(200);
    expect((await refresh(second.app)).status).toBe(200);
  });
});
