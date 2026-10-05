import { describe, expect, it, vi } from 'vitest';
import { EMPTY_LIST } from '../../application/issue-report/external-issue-list.js';
import { createHarness, makeIssue } from '../../application/issue-report/external-issue-test-support.js';
import { createExternalIssueRoutes, EXTERNAL_ISSUES_PATH, EXTERNAL_ISSUES_REFRESH_PATH } from './external-issue-routes.js';

const LOCAL = { incoming: { socket: { remoteAddress: '127.0.0.1', localPort: 8787 } } };
const REMOTE = { incoming: { socket: { remoteAddress: '192.0.2.1' } } };
const CF = { 'cf-ray': 'abc123-NRT', 'cf-connecting-ip': '203.0.113.9' };

describe('external issue routes', () => {
  it('returns a fixed disabled response and rejects refresh', async () => {
    const app = createExternalIssueRoutes({ service: undefined });
    expect(await (await app.request(EXTERNAL_ISSUES_PATH)).json()).toEqual({
      enabled: false, state: 'idle', fetchedAt: null, error: null, truncated: false, skippedLines: 0, issues: [],
    });
    expect((await app.request(EXTERNAL_ISSUES_REFRESH_PATH, { method: 'POST', headers: { host: 'localhost:8787', 'content-type': 'application/json' } }, LOCAL)).status).toBe(404);
  });

  it('keeps GET read-only and rate limits local refresh, including concurrent calls', async () => {
    let now = 0;
    const list = { ...EMPTY_LIST, state: 'error' as const, error: { kind: 'rate-limited' as const, detail: 'fixed detail' } };
    const service = { getList: vi.fn(() => list), poll: vi.fn(async () => list) };
    const app = createExternalIssueRoutes({ service, now: () => now });
    for (let i = 0; i < 50; i += 1) await app.request(EXTERNAL_ISSUES_PATH);
    expect(service.getList).toHaveBeenCalledTimes(50);
    expect(service.poll).not.toHaveBeenCalled();
    const localPost = () => app.request(EXTERNAL_ISSUES_REFRESH_PATH, {
      method: 'POST', headers: { host: 'localhost:8787', origin: 'http://localhost:8787', 'content-type': 'application/json' }, body: '{}',
    }, LOCAL);
    const [a, b] = await Promise.all([localPost(), localPost()]);
    expect([a.status, b.status].sort()).toEqual([200, 429]);
    const rejected = a.status === 429 ? a : b;
    expect(rejected.headers.get('Retry-After')).toBe('60');
    expect(await rejected.json()).toMatchObject({ code: 'refresh-rate-limited', retryAfterSeconds: 60 });
    expect(service.poll).toHaveBeenCalledTimes(1);
    now = 60_000;
    expect((await localPost()).status).toBe(200);
  });

  it('allows tunnel reads but keeps refresh local-only and protects CSRF', async () => {
    const service = { getList: vi.fn(() => EMPTY_LIST), poll: vi.fn(async () => EMPTY_LIST) };
    const app = createExternalIssueRoutes({ service });
    expect((await app.request(EXTERNAL_ISSUES_PATH, { headers: CF }, REMOTE)).status).toBe(200);
    const post = (headers: Record<string, string>) => app.request(EXTERNAL_ISSUES_REFRESH_PATH, {
      method: 'POST', headers: { host: 'example.com', origin: 'http://example.com', 'content-type': 'application/json', ...headers }, body: '{}',
    }, REMOTE);
    expect((await post(CF)).status).toBe(403);
    expect((await post({ 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    expect((await post({ 'content-type': 'text/plain' })).status).toBe(403);
    expect(service.poll).not.toHaveBeenCalled();
    const local = createExternalIssueRoutes({ service, refreshMinGapMs: 1 });
    expect((await local.request(EXTERNAL_ISSUES_REFRESH_PATH, { method: 'POST', headers: { host: 'localhost:8787', origin: 'http://localhost:8787', 'content-type': 'application/json' }, body: '{}' }, LOCAL)).status).toBe(200);
  });

  it('serializes service entries with an explicit DTO field set', async () => {
    const harness = createHarness();
    harness.setIssues([makeIssue(7)]);
    const result = await harness.service.poll();
    const app = createExternalIssueRoutes({ service: { getList: () => result, poll: () => Promise.resolve(result) } });
    const body = await (await app.request(EXTERNAL_ISSUES_PATH)).json() as { issues: Record<string, unknown>[] };
    expect(Object.keys(body.issues[0]!).sort()).toEqual([
      'author', 'authorAssociation', 'body', 'bodyLength', 'bodyTruncated', 'checks', 'needsRejudge', 'number',
      'snapshotAt', 'title', 'titleLength', 'titleTruncated', 'updatedAt', 'updatedAtChanged', 'url',
    ].sort());
  });
});
