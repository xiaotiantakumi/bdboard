import { describe, expect, it } from 'vitest';
import { createIssueDraftService } from '../../application/issue-report/issue-draft-service.js';
import { createInMemoryIssueDraftStorage } from '../../application/issue-report/issue-draft-test-support.js';
import { createIssueReportRoutes } from './issue-report-routes.js';

/**
 * bdboard-ov0t: PATCH で、見える文字が無い題名・本文 (ZWSP・U+2800 など) は 400 にも「直した」見えない文にもせず、自動の文へ戻す。
 * 題名も本文も同じ規則 (domain の hasVisibleText)。見える文字があって改行や不可視の書式文字を含む題名は、今までどおり 400。
 */

const DRAFTS = '/api/issue-reports/drafts';
const ENV = { incoming: { socket: { remoteAddress: '127.0.0.1', localPort: 8787 } } };

async function setup() {
  const storage = createInMemoryIssueDraftStorage();
  const service = createIssueDraftService({ storage, now: () => new Date('2026-10-04T12:00:00Z'), newId: () => '1758812345678-a1b2c3d4e5f6a7b8' });
  const app = createIssueReportRoutes({ service });
  const created = await app.request(DRAFTS, { method: 'POST', headers: { host: 'localhost:8787', 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'B', source: 'hook.sh' }) }, ENV);
  const id = ((await created.json()) as { draft: { id: string } }).draft.id;
  const automatic = { title: storage.drafts.get(id)?.title, body: storage.drafts.get(id)?.body };
  const patch = (body: unknown) =>
    app.request(`${DRAFTS}/${id}`, { method: 'PATCH', headers: { host: 'localhost:8787', 'content-type': 'application/json' }, body: JSON.stringify(body) }, ENV);
  return { storage, id, automatic, patch };
}

const INVISIBLE_ONLY = ['\u200B', '⠀', '\u200C', '\u2060', '\uFEFF', 'ㅤ', '\u202E', '́', '\u200B\n⠀\n'];

describe('PATCH draft: a title or body that shows nothing goes back to the automatic text (bdboard-ov0t)', () => {
  it.each(INVISIBLE_ONLY)('resets an edited body to the automatic text for %j', async (value) => {
    const { storage, id, automatic, patch } = await setup();
    await patch({ body: 'my own body' });
    expect(storage.drafts.get(id)).toMatchObject({ bodyEditedByUser: true, body: 'my own body' });
    const res = await patch({ body: value });
    expect(res.status).toBe(200);
    expect(storage.drafts.get(id)).toMatchObject({ bodyEditedByUser: false, body: automatic.body });
  });

  it.each(INVISIBLE_ONLY)('resets an edited title to the automatic text for %j, not 400', async (value) => {
    const { storage, id, automatic, patch } = await setup();
    await patch({ title: 'my own title' });
    expect(storage.drafts.get(id)).toMatchObject({ titleEditedByUser: true, title: 'my own title' });
    const res = await patch({ title: value });
    expect(res.status).toBe(200);
    expect(storage.drafts.get(id)).toMatchObject({ titleEditedByUser: false, title: automatic.title });
  });

  it('still keeps a body that has something to see, with its invisible characters as written', async () => {
    const { storage, id, patch } = await setup();
    expect((await patch({ body: '\u200Bnote⠀' })).status).toBe(200);
    expect(storage.drafts.get(id)).toMatchObject({ bodyEditedByUser: true, body: '\u200Bnote⠀' });
  });

  // 見える文字があるのに改行・制御文字・不可視の書式文字を含む題名は 400 (見える文字が無いものを自動へ戻すのとは別)。
  it.each(['abc\n', '\tdef', 'ab\u202Ec', 'a\u2060b'])('still rejects a title that has visible text and a line break or a format character: %j', async (title) => {
    const { storage, id, automatic, patch } = await setup();
    expect((await patch({ title })).status).toBe(400);
    expect(storage.drafts.get(id)?.title).toBe(automatic.title);
  });
});
