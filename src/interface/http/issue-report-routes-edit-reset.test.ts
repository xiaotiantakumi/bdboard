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

async function receiveAgain(app: ReturnType<typeof createIssueReportRoutes>) {
  return app.request(DRAFTS, { method: 'POST', headers: { host: 'localhost:8787', 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'B', source: 'hook.sh' }) }, ENV);
}

describe('PATCH draft reset', () => {
  it('accepts an empty title and body, and a title that shows nothing, as a reset (bdboard-ov0t)', async () => {
    const { app, storage, id } = await setup();
    const body = await patch(app, id, { body: '' });
    expect(body.status).toBe(200);
    expect(storage.drafts.get(id)).toMatchObject({ bodyEditedByUser: false });
    expect(storage.drafts.get(id)?.body).toContain('種類:');
    expect((await patch(app, id, { title: '' })).status).toBe(200);
    expect(storage.drafts.get(id)?.titleEditedByUser).toBe(false);
    expect((await patch(app, id, { title: '   ' })).status).toBe(200);
    // 見える文字が無い題名 (点字の空白だけ) は、以前は 400 だった。本文と同じく自動へ戻す。
    expect((await patch(app, id, { title: '⠀' })).status).toBe(200);
  });

  // 不具合報告の画面の「自動の文に戻す」ボタン (bdboard-494n) が頼る契約: #889 (pnvj) より前に '' と「直した」印で保存された欄も、
  // 欄を空にした PATCH で自動の文へ戻る (サーバーは今の値を見ない)。画面はこのとき、保存済みの値が空でも差分に関係なく送る。
  it('puts back a title and a body that were saved empty with the edited mark, one field at a time (bdboard-494n)', async () => {
    const { app, storage, id } = await setup();
    const automatic = storage.drafts.get(id);
    if (automatic === undefined) throw new Error('draft was not created');
    storage.drafts.set(id, { ...automatic, title: '', body: '', titleEditedByUser: true, bodyEditedByUser: true });
    const bodyReset = await patch(app, id, { body: '' });
    expect(bodyReset.status).toBe(200);
    const afterBody = ((await bodyReset.json()) as { draft: { title: string; body: string; titleEditedByUser: boolean; bodyEditedByUser: boolean } }).draft;
    expect(afterBody).toMatchObject({ title: '', titleEditedByUser: true, bodyEditedByUser: false, body: automatic.body });
    expect(storage.drafts.get(id)).toMatchObject({ title: '', titleEditedByUser: true, bodyEditedByUser: false, body: automatic.body });
    const titleReset = await patch(app, id, { title: '' });
    expect(titleReset.status).toBe(200);
    const afterTitle = ((await titleReset.json()) as { draft: { title: string; titleEditedByUser: boolean } }).draft;
    expect(afterTitle).toMatchObject({ title: automatic.title, titleEditedByUser: false });
    expect(afterTitle.title).not.toBe('');
    expect(storage.drafts.get(id)).toMatchObject({ title: automatic.title, titleEditedByUser: false });
  });

  it('resets a whitespace-only body and a whitespace-only title, including a lone newline', async () => {
    const { app, storage, id } = await setup();
    await patch(app, id, { title: 'custom', body: 'custom body' });
    expect(storage.drafts.get(id)).toMatchObject({ titleEditedByUser: true, bodyEditedByUser: true });
    expect((await patch(app, id, { body: ' \n ' })).status).toBe(200);
    expect(storage.drafts.get(id)).toMatchObject({ bodyEditedByUser: false, titleEditedByUser: true });
    expect(storage.drafts.get(id)?.body).toContain('種類:');
    expect((await patch(app, id, { title: '\n' })).status).toBe(200);
    expect(storage.drafts.get(id)).toMatchObject({ titleEditedByUser: false });
  });

  // 題名は整える前の値で 1 行かを見る。先に trim すると、前後の改行やタブが黙って通ってしまう (main では 400 だった)。
  it.each(['abc\n', '\tdef', 'a\nb'])('still rejects a title with a newline or tab at the edge: %j', async (title) => {
    const { app, storage, id } = await setup();
    const before = storage.drafts.get(id)?.title;
    expect((await patch(app, id, { title })).status).toBe(400);
    expect(storage.drafts.get(id)?.title).toBe(before);
  });

  it('rebuilds the automatic body on the next receive after a reset, but not while it stays edited', async () => {
    const { app, storage, id } = await setup();
    await patch(app, id, { body: 'my own text' });
    await receiveAgain(app);
    expect(storage.drafts.get(id)?.body).toBe('my own text');
    await patch(app, id, { body: '' });
    await receiveAgain(app);
    expect(storage.drafts.get(id)?.bodyEditedByUser).toBe(false);
    expect(storage.drafts.get(id)?.body).toContain('発生回数: 3');
  });
});
