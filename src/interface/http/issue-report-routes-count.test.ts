import { describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import { createIssueDraftService } from '../../application/issue-report/issue-draft-service.js';
import { createInMemoryIssueDraftStorage } from '../../application/issue-report/issue-draft-test-support.js';
import { ISSUE_REPORTS_PENDING_COUNT_PATH } from './issue-report-edit-routes.js';
import { createIssueReportRoutes } from './issue-report-routes.js';

/**
 * bdboard-vsuc: 一覧 GET drafts の pendingCount と GET pending-count が、同じ数え方で同じ値を返す
 * (手で消された下書きがあっても、見送りのあとでも)。setup() の書き方は issue-report-routes.test.ts に倣う。
 */

const LOCAL_ENV = { incoming: { socket: { remoteAddress: '127.0.0.1', localPort: 8787 } } };
const LOCAL_HOST = 'localhost:8787';
const DRAFTS = '/api/issue-reports/drafts';

function setup() {
  const storage = createInMemoryIssueDraftStorage();
  let seq = 0;
  const service = createIssueDraftService({
    storage,
    now: () => new Date('2026-10-04T12:00:00.000Z'),
    newId: () => {
      seq += 1;
      return `${1758812345000 + seq}-${seq.toString(16).padStart(16, '0')}`;
    },
  });
  return { app: createIssueReportRoutes({ service }), storage };
}

async function createDraft(app: Hono, slug: string): Promise<string> {
  const res = await app.request(
    DRAFTS,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', host: LOCAL_HOST },
      body: JSON.stringify({ kind: 'A', catalogSlug: slug, envInfo: { bdboardVersion: '0.1.2', os: 'darwin', nodeVersion: 'v22.14.0' } }),
    },
    LOCAL_ENV,
  );
  expect(res.status).toBe(201);
  return ((await res.json()) as { draft: { id: string } }).draft.id;
}

async function listCount(app: Hono): Promise<number> {
  const res = await app.request(DRAFTS, { headers: { host: LOCAL_HOST } }, LOCAL_ENV);
  return ((await res.json()) as { pendingCount: number }).pendingCount;
}

async function badgeCount(app: Hono): Promise<number> {
  const res = await app.request(ISSUE_REPORTS_PENDING_COUNT_PATH, { headers: { host: LOCAL_HOST } }, LOCAL_ENV);
  return ((await res.json()) as { pendingCount: number }).pendingCount;
}

describe('GET drafts pendingCount and GET pending-count', () => {
  it('return the same value after a pending draft was removed by hand (the list is read first)', async () => {
    const { app, storage } = setup();
    const first = await createDraft(app, 'one');
    await createDraft(app, 'two');
    storage.drafts.delete(first);

    expect(await listCount(app)).toBe(1);
    expect(await badgeCount(app)).toBe(1); // 修正前は 2 (索引が手で消された下書きを数え続ける)
  });

  it('return the same value after a dismiss', async () => {
    const { app } = setup();
    const first = await createDraft(app, 'one');
    await createDraft(app, 'two');
    expect(await listCount(app)).toBe(2);
    expect(await badgeCount(app)).toBe(2);

    const dismissed = await app.request(
      `${DRAFTS}/${first}/dismiss`,
      { method: 'PATCH', headers: { 'content-type': 'application/json', host: LOCAL_HOST }, body: JSON.stringify({ reason: 'not a bug' }) },
      LOCAL_ENV,
    );
    expect(dismissed.status).toBe(200);

    expect(await listCount(app)).toBe(1);
    expect(await badgeCount(app)).toBe(1);
  });

  it('list the drafts and the count from the same read', async () => {
    const { app, storage } = setup();
    const first = await createDraft(app, 'one');
    await createDraft(app, 'two');
    storage.drafts.delete(first);

    const res = await app.request(DRAFTS, { headers: { host: LOCAL_HOST } }, LOCAL_ENV);
    const body = (await res.json()) as { drafts: { id: string; status: string }[]; pendingCount: number };
    expect(body.drafts).toHaveLength(1);
    expect(body.pendingCount).toBe(body.drafts.filter((draft) => draft.status === 'pending').length);
  });
});
