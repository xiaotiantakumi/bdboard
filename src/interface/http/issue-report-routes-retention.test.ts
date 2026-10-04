import { describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import { createIssueDraftService } from '../../application/issue-report/issue-draft-service.js';
import {
  createInMemoryIssueDraftStorage,
  type InMemoryIssueDraftStorage,
} from '../../application/issue-report/issue-draft-test-support.js';
import { draftJsonBytes } from '../../domain/issue-draft-size.js';
import { createIssueReportRoutes } from './issue-report-routes.js';

/** bdboard-00qh: 合計容量の上限 (507) と、見送り済みの下書きへの画像追加 (409) の HTTP の形。 */

const LOCAL_ENV = { incoming: { socket: { remoteAddress: '127.0.0.1', localPort: 8787 } } };
const LOCAL_HOST = 'localhost:8787';
const DRAFTS = '/api/issue-reports/drafts';
const PNG_BASE64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64');
const ENV = { bdboardVersion: '0.1.2', os: 'darwin', nodeVersion: 'v22.14.0' };

function reportBody(letter: string) {
  return { kind: 'A', catalogSlug: `slug-${letter}`, symptom: 'symptom', envInfo: ENV };
}

function json(body: unknown, method = 'POST'): RequestInit {
  return {
    method,
    headers: { 'content-type': 'application/json', host: LOCAL_HOST },
    body: JSON.stringify(body),
  };
}

/** アプリを立て直しても id が重ならないよう、テスト全体で数える。 */
let seq = 0;

function appOn(storage: InMemoryIssueDraftStorage, maxTotalBytes?: number): Hono {
  const service = createIssueDraftService({
    storage,
    now: () => new Date('2026-10-04T12:00:00.000Z'),
    newId: () => `${1758812345000 + (seq += 1)}-${seq.toString(16).padStart(16, '0')}`,
    retention: { warn: () => undefined, ...(maxTotalBytes !== undefined ? { maxTotalBytes } : {}) },
  });
  return createIssueReportRoutes({ service });
}

function storedBytes(storage: InMemoryIssueDraftStorage): number {
  return [...storage.drafts.values()].reduce((sum, draft) => sum + draftJsonBytes(draft), 0);
}

async function create(app: Hono, letter: string): Promise<string> {
  const res = await app.request(DRAFTS, json(reportBody(letter)), LOCAL_ENV);
  expect(res.status).toBe(201);
  return ((await res.json()) as { draft: { id: string } }).draft.id;
}

describe('507: the issue-drafts directory is full of drafts the user has not finished', () => {
  it('refuses a new report with 507 and a stable error code, storing nothing', async () => {
    const storage = createInMemoryIssueDraftStorage();
    await create(appOn(storage), 'a');
    const app = appOn(storage, storedBytes(storage));

    const res = await app.request(DRAFTS, json(reportBody('b')), LOCAL_ENV);

    expect(res.status).toBe(507);
    expect(await res.json()).toEqual({ error: 'issue draft storage is full', code: 'storage-full' });
    expect(storage.drafts.size).toBe(1);
  });

  it('refuses an image with 507 and the same code, storing nothing', async () => {
    const storage = createInMemoryIssueDraftStorage();
    const id = await create(appOn(storage), 'a');
    const app = appOn(storage, storedBytes(storage));

    const res = await app.request(`${DRAFTS}/${id}/images`, json({ mimeType: 'image/png', data: PNG_BASE64 }), LOCAL_ENV);

    expect(res.status).toBe(507);
    expect(await res.json()).toEqual({ error: 'issue draft storage is full', code: 'storage-full' });
    expect(storage.images.get(id)?.size ?? 0).toBe(0);
  });

  it('still takes a report when a dismissed draft can be pruned to make room', async () => {
    const storage = createInMemoryIssueDraftStorage();
    const seedApp = appOn(storage);
    const dismissedId = await create(seedApp, 'a');
    await create(seedApp, 'c');
    const dismissRes = await seedApp.request(`${DRAFTS}/${dismissedId}/dismiss`, json({ reason: 'not a bug' }, 'PATCH'), LOCAL_ENV);
    expect(dismissRes.status).toBe(200);
    const app = appOn(storage, storedBytes(storage));

    const res = await app.request(DRAFTS, json(reportBody('d')), LOCAL_ENV);

    expect(res.status).toBe(201);
    expect(storage.drafts.has(dismissedId)).toBe(false);
  });
});

describe('409: an image for a draft that is already finished', () => {
  it('is refused with a stable error code and the draft status, and nothing is stored', async () => {
    const storage = createInMemoryIssueDraftStorage();
    const app = appOn(storage);
    const id = await create(app, 'a');
    const dismiss = await app.request(`${DRAFTS}/${id}/dismiss`, json({ reason: 'not a bug' }, 'PATCH'), LOCAL_ENV);
    expect(dismiss.status).toBe(200);

    const res = await app.request(`${DRAFTS}/${id}/images`, json({ mimeType: 'image/png', data: PNG_BASE64 }), LOCAL_ENV);

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'images can only be added to a pending draft',
      code: 'draft-not-pending',
      status: 'dismissed',
    });
    expect(storage.images.get(id)?.size ?? 0).toBe(0);
  });

  it('is answered before the body is read: a dismissed draft gets 409 even for a body that would be a 400', async () => {
    const storage = createInMemoryIssueDraftStorage();
    const app = appOn(storage);
    const id = await create(app, 'a');
    await app.request(`${DRAFTS}/${id}/dismiss`, json({ reason: 'not a bug' }, 'PATCH'), LOCAL_ENV);

    const res = await app.request(
      `${DRAFTS}/${id}/images`,
      { method: 'POST', headers: { 'content-type': 'application/json', host: LOCAL_HOST }, body: 'not json at all' },
      LOCAL_ENV,
    );

    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe('draft-not-pending');
  });

  it('is still accepted (201) while the draft is pending', async () => {
    const storage = createInMemoryIssueDraftStorage();
    const app = appOn(storage);
    const id = await create(app, 'a');

    const res = await app.request(`${DRAFTS}/${id}/images`, json({ mimeType: 'image/png', data: PNG_BASE64 }), LOCAL_ENV);

    expect(res.status).toBe(201);
  });
});
