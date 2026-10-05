import { describe, expect, it } from 'vitest';
import { createIssueDraftService } from '../../application/issue-report/issue-draft-service.js';
import { createInMemoryIssueDraftStorage } from '../../application/issue-report/issue-draft-test-support.js';
import { createIssueReportRoutes } from './issue-report-routes.js';

const DRAFTS = '/api/issue-reports/drafts';
const ENV = { incoming: { socket: { remoteAddress: '127.0.0.1', localPort: 8787 } } };
async function setup() {
  const storage = createInMemoryIssueDraftStorage();
  const service = createIssueDraftService({ storage, now: () => new Date('2026-10-04T12:00:00Z'), newId: () => '1758812345678-a1b2c3d4e5f6a7b8' });
  const app = createIssueReportRoutes({ service });
  const created = await app.request(DRAFTS, { method: 'POST', headers: { host: 'localhost:8787', 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'B', source: 'hook.sh' }) }, ENV);
  const id = ((await created.json()) as { draft: { id: string } }).draft.id;
  return { app, storage, id };
}
async function patch(app: ReturnType<typeof createIssueReportRoutes>, id: string, body: unknown) {
  return app.request(`${DRAFTS}/${id}`, { method: 'PATCH', headers: { host: 'localhost:8787', 'content-type': 'application/json' }, body: JSON.stringify(body) }, ENV);
}

describe('PATCH draft reset', () => {
  it('accepts empty title and body, while still rejecting invisible non-whitespace title', async () => {
    const { app, storage, id } = await setup();
    const body = await patch(app, id, { body: '' });
    expect(body.status).toBe(200);
    expect(storage.drafts.get(id)).toMatchObject({ bodyEditedByUser: false });
    expect(storage.drafts.get(id)?.body).toContain('種類:');
    expect((await patch(app, id, { title: '' })).status).toBe(200);
    expect(storage.drafts.get(id)?.titleEditedByUser).toBe(false);
    expect((await patch(app, id, { title: '   ' })).status).toBe(200);
    expect((await patch(app, id, { title: '⠀' })).status).toBe(400);
  });
});
