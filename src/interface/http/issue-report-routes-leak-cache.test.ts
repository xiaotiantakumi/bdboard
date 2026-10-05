import { describe, expect, it, vi } from 'vitest';
import { createIssueDraftService } from '../../application/issue-report/issue-draft-service.js';
import { createInMemoryIssueDraftStorage } from '../../application/issue-report/issue-draft-test-support.js';
import { createRestrictedLeakCache } from './issue-report-leak-cache.js';
import { createIssueReportRoutes } from './issue-report-routes.js';
import type { DraftLeakScan } from '../../domain/issue-draft-edit.js';

const PATH = '/api/issue-reports/drafts';
const LOCAL = { incoming: { socket: { remoteAddress: '127.0.0.1', localPort: 8787 } } };
const TUNNEL = { 'cf-ray': 'ray-NRT', 'cf-connecting-ip': '203.0.113.9' };

describe('restricted leak cache in routes', () => {
  it('reuses tunnel scans, invalidates edited text, and skips local scans', async () => {
    const storage = createInMemoryIssueDraftStorage();
    const service = createIssueDraftService({ storage, now: () => new Date('2026-10-04T12:00:00Z'), newId: () => '1758812345678-a1b2c3d4e5f6a7b8' });
    const result: DraftLeakScan = { suspectedLeaks: [], omitted: 0 };
    const spy = vi.fn(() => result);
    const app = createIssueReportRoutes({ service, writeAccess: { isTunnelWriteAllowed: () => true, hasTunnelSession: () => true }, leakCache: createRestrictedLeakCache({ scan: spy }) });
    const created = await app.request(PATH, { method: 'POST', headers: { host: 'localhost:8787', 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'B', source: 'hook.sh' }) }, LOCAL);
    const id = ((await created.json()) as { draft: { id: string } }).draft.id;
    await service.edit(id, { body: 'edited' });
    const get = () => app.request(`${PATH}/${id}`, { headers: { host: 'tunnel.example', ...TUNNEL } }, { incoming: { socket: { remoteAddress: '203.0.113.9', localPort: 8787 } } });
    await get(); await get();
    expect(spy).toHaveBeenCalledTimes(1);
    await app.request(`${PATH}/${id}`, { method: 'PATCH', headers: { host: 'tunnel.example', 'content-type': 'application/json', ...TUNNEL }, body: JSON.stringify({ body: 'edited again' }) }, { incoming: { socket: { remoteAddress: '203.0.113.9', localPort: 8787 } } });
    // PATCH の応答もキャッシュを通る (検出は PATCH で 1 回増え、そのあとの GET は同じ内容なので増えない)。
    expect(spy).toHaveBeenCalledTimes(2);
    await get();
    expect(spy).toHaveBeenCalledTimes(2);
    await app.request(`${PATH}/${id}`, { headers: { host: 'localhost:8787' } }, LOCAL);
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
