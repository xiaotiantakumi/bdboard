// トンネル側の検出キャッシュは、編集済みの本文に書かれた名前のプロジェクトが受け取りで増えたあとに、古い結果を返してはいけない
// (指紋に鍵を入れ忘れると落ちる。bdboard-pnvj の PR #889 のレビュー MINOR-1)。
import { describe, expect, it } from 'vitest';
import { createIssueDraftService } from '../../application/issue-report/issue-draft-service.js';
import { createInMemoryIssueDraftStorage } from '../../application/issue-report/issue-draft-test-support.js';
import { createIssueReportRoutes } from './issue-report-routes.js';

const PATH = '/api/issue-reports/drafts';
const LOCAL = { incoming: { socket: { remoteAddress: '127.0.0.1', localPort: 8787 } } };
const TUNNEL_ENV = { incoming: { socket: { remoteAddress: '203.0.113.9', localPort: 8787 } } };
const TUNNEL = { host: 'tunnel.example', 'cf-ray': 'ray-NRT', 'cf-connecting-ip': '203.0.113.9' };

describe('restricted leak cache and new projects', () => {
  it('re-scans the tunnel view when a receive adds a project named in the edited body', async () => {
    const storage = createInMemoryIssueDraftStorage();
    const service = createIssueDraftService({ storage, now: () => new Date('2026-10-04T12:00:00Z'), newId: () => '1758812345678-a1b2c3d4e5f6a7b8' });
    const app = createIssueReportRoutes({ service, writeAccess: { isTunnelWriteAllowed: () => true, hasTunnelSession: () => true } });
    const receive = (project: { name: string; path: string }) =>
      app.request(PATH, { method: 'POST', headers: { host: 'localhost:8787', 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'B', source: 'hook.sh', project }) }, LOCAL);
    const id = ((await (await receive({ name: 'first-proj', path: '/work/first-proj' })).json()) as { draft: { id: string } }).draft.id;
    await app.request(`${PATH}/${id}`, { method: 'PATCH', headers: { ...TUNNEL, 'content-type': 'application/json' }, body: JSON.stringify({ body: 'fails in second-proj too' }) }, TUNNEL_ENV);
    const get = async () =>
      ((await (await app.request(`${PATH}/${id}`, { headers: TUNNEL }, TUNNEL_ENV)).json()) as { draft: { suspectedLeaks?: { field: string }[] } }).draft;
    expect((await get()).suspectedLeaks).toEqual([]);
    await receive({ name: 'second-proj', path: '/work/second-proj' });
    expect((await get()).suspectedLeaks?.some((leak) => leak.field === 'body')).toBe(true);
  });
});
