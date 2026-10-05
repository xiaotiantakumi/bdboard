// トンネル側の検出キャッシュの指紋は、検出する欄 (直した欄) と鍵だけから作る (bdboard-ov0t)。
// 題名だけ直した下書きの本文は自動の文で、受け取りのたびに回数・時刻で変わるが、検出の入力ではないのでキャッシュに当たる。
// 直した欄が変われば (題名の再編集・本文を直す) 検出をかけ直す。
import { describe, expect, it, vi } from 'vitest';
import { createIssueDraftService } from '../../application/issue-report/issue-draft-service.js';
import { createInMemoryIssueDraftStorage } from '../../application/issue-report/issue-draft-test-support.js';
import { createRestrictedLeakCache } from './issue-report-leak-cache.js';
import { createIssueReportRoutes } from './issue-report-routes.js';
import type { DraftLeakScan, DraftTextToScan } from '../../domain/issue-draft-edit.js';

const PATH = '/api/issue-reports/drafts';
const LOCAL = { incoming: { socket: { remoteAddress: '127.0.0.1', localPort: 8787 } } };
const TUNNEL_ENV = { incoming: { socket: { remoteAddress: '203.0.113.9', localPort: 8787 } } };
const TUNNEL = { host: 'tunnel.example', 'cf-ray': 'ray-NRT', 'cf-connecting-ip': '203.0.113.9' };

async function setup() {
  const storage = createInMemoryIssueDraftStorage();
  const service = createIssueDraftService({ storage, now: () => new Date('2026-10-04T12:00:00Z'), newId: () => '1758812345678-a1b2c3d4e5f6a7b8' });
  const scanned: DraftTextToScan[] = [];
  const result: DraftLeakScan = { suspectedLeaks: [], omitted: 0 };
  const spy = vi.fn((text: DraftTextToScan) => {
    scanned.push(text);
    return result;
  });
  const app = createIssueReportRoutes({
    service,
    writeAccess: { isTunnelWriteAllowed: () => true, hasTunnelSession: () => true },
    leakCache: createRestrictedLeakCache({ scan: spy }),
  });
  const receive = () =>
    app.request(PATH, { method: 'POST', headers: { host: 'localhost:8787', 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'B', source: 'hook.sh' }) }, LOCAL);
  const id = ((await (await receive()).json()) as { draft: { id: string } }).draft.id;
  const tunnelGet = () => app.request(`${PATH}/${id}`, { headers: TUNNEL }, TUNNEL_ENV);
  const tunnelPatch = (body: unknown) =>
    app.request(`${PATH}/${id}`, { method: 'PATCH', headers: { ...TUNNEL, 'content-type': 'application/json' }, body: JSON.stringify(body) }, TUNNEL_ENV);
  return { storage, id, spy, scanned, receive, tunnelGet, tunnelPatch };
}

describe('restricted leak cache and the fields that are not scanned', () => {
  it('keeps the cached scan across receives while only the title was edited (the automatic body changes every receive)', async () => {
    const { storage, id, spy, receive, tunnelGet, tunnelPatch } = await setup();
    expect((await tunnelPatch({ title: 'my own title' })).status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(1);
    await tunnelGet();
    expect(spy).toHaveBeenCalledTimes(1);

    const bodyBefore = storage.drafts.get(id)?.body;
    await receive();
    await receive();
    // 受け取りのたびに自動の本文 (発生回数) は変わるが、題名だけを直した下書きの検出は同じ結果を使う。
    expect(storage.drafts.get(id)?.body).not.toBe(bodyBefore);
    expect(storage.drafts.get(id)).toMatchObject({ titleEditedByUser: true, bodyEditedByUser: false });
    await tunnelGet();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('scans again when the edited title changes, and when the body becomes edited', async () => {
    const { spy, scanned, tunnelGet, tunnelPatch } = await setup();
    await tunnelPatch({ title: 'my own title' });
    await tunnelGet();
    expect(spy).toHaveBeenCalledTimes(1);
    await tunnelPatch({ title: 'a different title' });
    expect(spy).toHaveBeenCalledTimes(2);
    await tunnelPatch({ body: 'now the body is edited too' });
    expect(spy).toHaveBeenCalledTimes(3);
    expect(scanned[2]).toMatchObject({ title: 'a different title', body: 'now the body is edited too', titleEdited: true, bodyEdited: true });
    await tunnelGet();
    expect(spy).toHaveBeenCalledTimes(3);
  });
});
