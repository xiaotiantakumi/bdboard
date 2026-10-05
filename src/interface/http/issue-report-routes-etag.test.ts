import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import {
  createIssueDraftService,
  type IssueDraftService,
} from '../../application/issue-report/issue-draft-service.js';
import {
  createInMemoryIssueDraftStorage,
  type InMemoryIssueDraftStorage,
} from '../../application/issue-report/issue-draft-test-support.js';
import { createBasicAuthMiddleware } from './basic-auth.js';
import { createCompressionMiddleware } from './compression.js';
import { createIssueReportRoutes } from './issue-report-routes.js';
import type { WriteGuardDeps } from './write-guard.js';

/**
 * bdboard-mqoa: 一覧と 1 件の取得の ETag / If-None-Match (304) と、編集 (PATCH) の If-Match (412)。
 * ETag は応答の本文そのものから作る (issue-report-etag.ts) ので、本文に出るものが変わるたびに変わることを 1 つずつ確かめる。
 * bdboard-q5pj: 1 件の ETag は `"<editDigest>-<bodyDigest>"`。If-None-Match は全体、If-Match は editDigest (直せる欄だけ) で比べる。
 */

const LOCAL_ENV = { incoming: { socket: { remoteAddress: '127.0.0.1', localPort: 8787 } } };
const LOCAL_HOST = 'localhost:8787';
const CF_HEADERS = { 'cf-ray': 'abc123-NRT', 'cf-connecting-ip': '203.0.113.9' } as const;
const DRAFTS = '/api/issue-reports/drafts';
const PNG_BASE64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64');
const TUNNEL_WRITE_ALLOWED: WriteGuardDeps = { isTunnelWriteAllowed: () => true, hasTunnelSession: () => true };
/** 1 件の取得・編集の応答の ETag は `"<editDigest>-<bodyDigest>"` (bdboard-q5pj)。一覧は本文全体の 1 つのダイジェスト。 */
const DETAIL_ETAG = /^"[0-9a-f]{32}-[0-9a-f]{32}"$/;
const LIST_ETAG = /^"[0-9a-f]{32}"$/;
/** If-Match に付ける、形は合っていて中身が違う ETag。 */
const WRONG_ETAG = `"${'0'.repeat(32)}-${'1'.repeat(32)}"`;

interface Setup {
  readonly app: Hono;
  readonly router: Hono;
  readonly service: IssueDraftService;
  readonly storage: InMemoryIssueDraftStorage;
  /** 時計と、最新の harness pack の版 (テストが動かす)。 */
  readonly world: { now: Date; latest: string | undefined };
}

function setup(options: { writeAccess?: WriteGuardDeps; compression?: boolean } = {}): Setup {
  const world = { now: new Date('2026-10-04T12:00:00.000Z'), latest: '0.50.0' as string | undefined };
  const storage = createInMemoryIssueDraftStorage(() => world.now);
  let seq = 0;
  const service = createIssueDraftService({
    storage,
    now: () => world.now,
    newId: () => {
      seq += 1;
      return `${1758812345000 + seq}-${seq.toString(16).padStart(16, '0')}`;
    },
  });
  const router = createIssueReportRoutes({
    service,
    ...(options.writeAccess !== undefined ? { writeAccess: options.writeAccess } : {}),
    latestHarnessVersion: async () => world.latest,
  });
  const app = new Hono();
  if (options.compression === true) app.use('*', createCompressionMiddleware());
  app.route('/', router);
  return { app, router, service, storage, world };
}

function json(method: string, body: unknown, headers: Record<string, string> = {}): RequestInit {
  return { method, headers: { 'content-type': 'application/json', host: LOCAL_HOST, ...headers }, body: JSON.stringify(body) };
}
const patch = (body: unknown, headers: Record<string, string> = {}) => json('PATCH', body, headers);
const read = (headers: Record<string, string> = {}): RequestInit => ({ headers: { host: LOCAL_HOST, ...headers } });

async function receive(app: Hono, slug: string): Promise<string> {
  const res = await app.request(
    DRAFTS,
    json('POST', { kind: 'A', catalogSlug: slug, envInfo: { bdboardVersion: '0.1.2', os: 'darwin', nodeVersion: 'v22.14.0' } }),
    LOCAL_ENV,
  );
  expect([200, 201]).toContain(res.status);
  return ((await res.json()) as { draft: { id: string } }).draft.id;
}

async function etagOf(app: Hono, path: string, env: object = LOCAL_ENV, headers: Record<string, string> = {}): Promise<string> {
  const res = await app.request(path, read(headers), env);
  expect(res.status).toBe(200);
  const etag = res.headers.get('ETag');
  expect(etag).toMatch(path === DRAFTS ? LIST_ETAG : DETAIL_ETAG);
  return etag as string;
}

describe('GET /api/issue-reports/drafts/:id — ETag and If-None-Match', () => {
  it('sends a strong ETag with private, no-cache, and the same ETag on every identical read', async () => {
    const { app } = setup();
    const id = await receive(app, 'slug-a');
    const res = await app.request(`${DRAFTS}/${id}`, read(), LOCAL_ENV);
    expect(res.status).toBe(200);
    expect(res.headers.get('ETag')).toMatch(DETAIL_ETAG);
    expect(res.headers.get('Cache-Control')).toBe('private, no-cache');
    expect(await etagOf(app, `${DRAFTS}/${id}`)).toBe(res.headers.get('ETag'));
  });

  it('answers 304 with no body (and the ETag, Cache-Control and Vary kept) when If-None-Match matches', async () => {
    const { app } = setup();
    const id = await receive(app, 'slug-a');
    const etag = await etagOf(app, `${DRAFTS}/${id}`);
    const res = await app.request(`${DRAFTS}/${id}`, read({ 'if-none-match': etag }), LOCAL_ENV);
    expect(res.status).toBe(304);
    expect(await res.text()).toBe('');
    expect(res.headers.get('ETag')).toBe(etag);
    expect(res.headers.get('Cache-Control')).toBe('private, no-cache');
    expect(res.headers.get('Vary')).toBe('Accept-Encoding');
  });

  it('matches by weak comparison, in a list, and with *; a different tag gets the full body', async () => {
    const { app } = setup();
    const id = await receive(app, 'slug-a');
    const etag = await etagOf(app, `${DRAFTS}/${id}`);
    for (const header of [`W/${etag}`, `"other", ${etag}`, '*']) {
      expect((await app.request(`${DRAFTS}/${id}`, read({ 'if-none-match': header }), LOCAL_ENV)).status).toBe(304);
    }
    const stale = await app.request(`${DRAFTS}/${id}`, read({ 'if-none-match': '"0123456789abcdef0123456789abcdef"' }), LOCAL_ENV);
    expect(stale.status).toBe(200);
    expect(((await stale.json()) as { draft: { id: string } }).draft.id).toBe(id);
  });

  it('still answers 404 and 400 for an unknown or malformed id, whatever If-None-Match says', async () => {
    const { app } = setup();
    expect((await app.request(`${DRAFTS}/1758812349999-ffffffffffffffff`, read({ 'if-none-match': '*' }), LOCAL_ENV)).status).toBe(404);
    expect((await app.request(`${DRAFTS}/not-an-id`, read({ 'if-none-match': '*' }), LOCAL_ENV)).status).toBe(400);
  });

  it('changes when anything in the body changes: an edit, a new occurrence, an image, the latest pack version, a dismiss', async () => {
    const { app, world } = setup();
    const id = await receive(app, 'slug-a');
    const seen = new Set<string>([await etagOf(app, `${DRAFTS}/${id}`)]);
    const expectNew = async (what: string) => {
      const etag = await etagOf(app, `${DRAFTS}/${id}`);
      expect(seen.has(etag), what).toBe(false);
      seen.add(etag);
    };

    expect((await app.request(`${DRAFTS}/${id}`, patch({ title: 'My title' }), LOCAL_ENV)).status).toBe(200);
    await expectNew('after an edit');
    world.now = new Date('2026-10-04T12:30:00.000Z');
    expect(await receive(app, 'slug-a')).toBe(id); // 同じ指紋 = 同じ下書きへのまとめ (回数・時刻が変わる)
    await expectNew('after a new occurrence');
    expect((await app.request(`${DRAFTS}/${id}/images`, json('POST', { mimeType: 'image/png', data: PNG_BASE64 }), LOCAL_ENV)).status).toBe(201);
    await expectNew('after an image was added');
    world.latest = '0.51.0';
    await expectNew('after the latest pack version moved');
    world.latest = undefined;
    await expectNew('after the latest pack version became unreadable');
    expect((await app.request(`${DRAFTS}/${id}/dismiss`, patch({ reason: 'not a bug' }), LOCAL_ENV)).status).toBe(200);
    await expectNew('after a dismiss');
  });

  it('keeps a local ETag and a tunnel ETag apart (the body differs), and 304s each only for its own', async () => {
    const { app } = setup();
    const id = await receive(app, 'slug-a');
    const local = await etagOf(app, `${DRAFTS}/${id}`);
    const tunnel = await etagOf(app, `${DRAFTS}/${id}`, LOCAL_ENV, CF_HEADERS);
    expect(tunnel).not.toBe(local);
    expect((await app.request(`${DRAFTS}/${id}`, read({ ...CF_HEADERS, 'if-none-match': local }), LOCAL_ENV)).status).toBe(200);
    expect((await app.request(`${DRAFTS}/${id}`, read({ ...CF_HEADERS, 'if-none-match': tunnel }), LOCAL_ENV)).status).toBe(304);
  });
});

describe('GET /api/issue-reports/drafts — ETag and If-None-Match', () => {
  it('sends a strong ETag, answers 304 when it matches (an empty list too), and a full list when it does not', async () => {
    const { app } = setup();
    const empty = await etagOf(app, DRAFTS);
    expect((await app.request(DRAFTS, read({ 'if-none-match': empty }), LOCAL_ENV)).status).toBe(304);
    await receive(app, 'slug-a');
    const res = await app.request(DRAFTS, read({ 'if-none-match': empty }), LOCAL_ENV);
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('private, no-cache');
    const etag = res.headers.get('ETag') as string;
    expect(etag).not.toBe(empty);
    const notModified = await app.request(DRAFTS, read({ 'if-none-match': etag }), LOCAL_ENV);
    expect(notModified.status).toBe(304);
    expect(await notModified.text()).toBe('');
    expect(notModified.headers.get('ETag')).toBe(etag);
  });

  it('changes when a draft is added, edited in the title, merged into or dismissed', async () => {
    const { app, world } = setup();
    const idA = await receive(app, 'slug-a');
    const seen = new Set<string>([await etagOf(app, DRAFTS)]);
    const expectNew = async (what: string) => {
      const etag = await etagOf(app, DRAFTS);
      expect(seen.has(etag), what).toBe(false);
      seen.add(etag);
    };
    world.now = new Date('2026-10-04T12:10:00.000Z');
    await receive(app, 'slug-b');
    await expectNew('after a new draft');
    expect((await app.request(`${DRAFTS}/${idA}`, patch({ title: 'Renamed' }), LOCAL_ENV)).status).toBe(200);
    await expectNew('after a title edit');
    world.now = new Date('2026-10-04T12:20:00.000Z');
    await receive(app, 'slug-a');
    await expectNew('after a merge into an existing draft');
    expect((await app.request(`${DRAFTS}/${idA}/dismiss`, patch({ reason: 'not a bug' }), LOCAL_ENV)).status).toBe(200);
    await expectNew('after a dismiss');
  });

  it('changes with the order of the drafts and with the pending count even when each draft is the same', async () => {
    const { app, service, world } = setup();
    await receive(app, 'slug-a');
    world.now = new Date('2026-10-04T12:10:00.000Z');
    await receive(app, 'slug-b');
    const { drafts, pendingCount } = await service.listWithPendingCount();
    expect(drafts).toHaveLength(2);

    const listEtag = async (ordered: typeof drafts, count: number) => {
      const stubbed = createIssueReportRoutes({ service: { ...service, listWithPendingCount: async () => ({ drafts: ordered, pendingCount: count }) } });
      return etagOf(stubbed, DRAFTS);
    };
    const base = await listEtag(drafts, pendingCount);
    expect(await listEtag(drafts, pendingCount)).toBe(base);
    expect(await listEtag([...drafts].reverse(), pendingCount)).not.toBe(base);
    expect(await listEtag(drafts, pendingCount - 1)).not.toBe(base);
  });
});

describe('PATCH /api/issue-reports/drafts/:id — If-Match', () => {
  it('applies the edit when If-Match is the current ETag, and answers the new ETag that the next GET gives', async () => {
    const { app } = setup();
    const id = await receive(app, 'slug-a');
    const before = await etagOf(app, `${DRAFTS}/${id}`);
    const res = await app.request(`${DRAFTS}/${id}`, patch({ title: 'Edited' }, { 'if-match': before }), LOCAL_ENV);
    expect(res.status).toBe(200);
    const after = res.headers.get('ETag');
    expect(after).toMatch(DETAIL_ETAG);
    expect(after).not.toBe(before);
    expect(await etagOf(app, `${DRAFTS}/${id}`)).toBe(after);
    // 応答の ETag のまま、次の編集を続けて送れる (保存のたびに 412 にならない)。
    const next = await app.request(`${DRAFTS}/${id}`, patch({ body: 'Second edit' }, { 'if-match': after as string }), LOCAL_ENV);
    expect(next.status).toBe(200);
    expect(next.headers.get('ETag')).not.toBe(after);
  });

  it('answers an ETag that covers the images too, so it equals the next GET for a draft with an image (and the tunnel form)', async () => {
    const { app } = setup({ writeAccess: TUNNEL_WRITE_ALLOWED });
    const id = await receive(app, 'slug-a');
    expect((await app.request(`${DRAFTS}/${id}/images`, json('POST', { mimeType: 'image/png', data: PNG_BASE64 }), LOCAL_ENV)).status).toBe(201);
    for (const headers of [{}, CF_HEADERS]) {
      const before = await etagOf(app, `${DRAFTS}/${id}`, LOCAL_ENV, headers);
      const res = await app.request(`${DRAFTS}/${id}`, patch({ body: `edited ${Object.keys(headers).length}` }, { ...headers, 'if-match': before }), LOCAL_ENV);
      expect(res.status).toBe(200);
      expect(res.headers.get('ETag')).toBe(await etagOf(app, `${DRAFTS}/${id}`, LOCAL_ENV, headers));
    }
  });

  it('answers 412 in the usual error shape and writes nothing when the draft changed since it was read', async () => {
    const { app, storage } = setup();
    const id = await receive(app, 'slug-a');
    const stale = await etagOf(app, `${DRAFTS}/${id}`);
    expect((await app.request(`${DRAFTS}/${id}`, patch({ title: 'Edited elsewhere' }), LOCAL_ENV)).status).toBe(200);
    const before = structuredClone(storage.drafts.get(id));
    const res = await app.request(`${DRAFTS}/${id}`, patch({ title: 'Mine' }, { 'if-match': stale }), LOCAL_ENV);
    expect(res.status).toBe(412);
    expect(await res.json()).toEqual({ error: 'draft was changed since it was read', code: 'precondition-failed' });
    expect(res.headers.get('ETag')).toBeNull();
    expect(storage.drafts.get(id)).toEqual(before);
  });

  it('keeps passing a request without If-Match (backward compatible), even after the draft changed', async () => {
    const { app, storage } = setup();
    const id = await receive(app, 'slug-a');
    expect((await app.request(`${DRAFTS}/${id}`, patch({ title: 'One' }), LOCAL_ENV)).status).toBe(200);
    expect((await app.request(`${DRAFTS}/${id}`, patch({ title: 'Two' }), LOCAL_ENV)).status).toBe(200);
    expect(storage.drafts.get(id)?.title).toBe('Two');
  });

  it('puts the draft back to automatic text under the same If-Match rule', async () => {
    const { app, storage } = setup();
    const id = await receive(app, 'slug-a');
    const autoTitle = storage.drafts.get(id)?.title;
    expect((await app.request(`${DRAFTS}/${id}`, patch({ title: 'Mine' }), LOCAL_ENV)).status).toBe(200);
    const current = await etagOf(app, `${DRAFTS}/${id}`);
    expect((await app.request(`${DRAFTS}/${id}`, patch({ title: '' }, { 'if-match': WRONG_ETAG }), LOCAL_ENV)).status).toBe(412);
    expect(storage.drafts.get(id)).toMatchObject({ title: 'Mine', titleEditedByUser: true });
    const reset = await app.request(`${DRAFTS}/${id}`, patch({ title: '' }, { 'if-match': current }), LOCAL_ENV);
    expect(reset.status).toBe(200);
    expect(reset.headers.get('ETag')).toMatch(DETAIL_ETAG);
    expect(storage.drafts.get(id)).toMatchObject({ title: autoTitle, titleEditedByUser: false });
  });

  it('reads If-Match as a list, with *, and ignoring a W/ prefix; anything else, including an empty one, is 412', async () => {
    const { app } = setup();
    const id = await receive(app, 'slug-a');
    const edit = async (ifMatch: string) => (await app.request(`${DRAFTS}/${id}`, patch({ body: `via ${ifMatch}` }, { 'if-match': ifMatch }), LOCAL_ENV)).status;
    const current = async () => etagOf(app, `${DRAFTS}/${id}`);
    expect(await edit('*')).toBe(200);
    expect(await edit(`"deadbeef", ${await current()}`)).toBe(200);
    expect(await edit(`W/${await current()}`)).toBe(200);
    for (const bad of ['', ' , ', 'garbage', '"deadbeef"', 'W/"deadbeef"', WRONG_ETAG, `W/${WRONG_ETAG}`]) expect(await edit(bad)).toBe(412);
  });

  // 前の形の ETag (本文全体の 32 桁 1 つ) は、この形ではないので一致しない。デプロイをまたいだ古い画面は 1 回 412 になり、読み直せば新しい形になる。
  it('does not take the previous ETag format, a single 32-hex digest, and the 412 leaves the draft as it was', async () => {
    const { app, storage } = setup();
    const id = await receive(app, 'slug-a');
    const [editDigest] = (await etagOf(app, `${DRAFTS}/${id}`)).slice(1, -1).split('-');
    const res = await app.request(`${DRAFTS}/${id}`, patch({ title: 'Mine' }, { 'if-match': `"${editDigest}"` }), LOCAL_ENV);
    expect(res.status).toBe(412);
    expect(storage.drafts.get(id)?.titleEditedByUser).toBe(false);
  });

  // 直せる欄の版は、読み手が見た形の題名・本文から作る。トンネルの読み手へは、ホーム配下のパスを畳んだ後の文の版だけを渡し、畳む前の文の
  // 指紋は渡さない (パスの一部を当てて確かめる道具にしない)。直した題名にパスがあれば、手元とトンネルで前半が違う。
  it('makes the edit digest from the text as the reader saw it: a home path in an edited title differs between local and tunnel', async () => {
    const { app, storage } = setup({ writeAccess: TUNNEL_WRITE_ALLOWED });
    const id = await receive(app, 'slug-a');
    expect((await app.request(`${DRAFTS}/${id}`, patch({ title: 'Fails in /Users/example-user/work/app' }), LOCAL_ENV)).status).toBe(200);
    const local = await etagOf(app, `${DRAFTS}/${id}`);
    const tunnel = await etagOf(app, `${DRAFTS}/${id}`, LOCAL_ENV, CF_HEADERS);
    expect(local.slice(1, 33)).not.toBe(tunnel.slice(1, 33));
    const edit = (ifMatch: string, headers: Record<string, string>, title: string) =>
      app.request(`${DRAFTS}/${id}`, patch({ title }, { ...headers, 'if-match': ifMatch }), LOCAL_ENV);
    expect((await edit(local, CF_HEADERS, 'From the tunnel')).status).toBe(412);
    expect((await edit(tunnel, {}, 'From local')).status).toBe(412);
    expect(storage.drafts.get(id)?.title).toBe('Fails in /Users/example-user/work/app');
    expect((await edit(tunnel, CF_HEADERS, 'From the tunnel')).status).toBe(200);
    expect((await edit(await etagOf(app, `${DRAFTS}/${id}`), {}, 'From local')).status).toBe(200);
  });

  // bdboard-q5pj: If-Match は ETag の前半 (直せる欄だけの版) で比べる。読んだあとの新しい発生・画像の追加・pack の版の変化は、
  // 応答の本文 (If-None-Match の相手の ETag) は変えても、直せる欄は変えないので、編集は通る。PATCH は今の下書きへ当たるので、
  // それらは上書きで失われない。
  describe('a change that is not an edited field (a new occurrence, an added image, a moved pack version)', () => {
    const imagePost = json('POST', { mimeType: 'image/png', data: PNG_BASE64 });

    const changes: ReadonlyArray<readonly [string, (ctx: Setup, id: string) => Promise<void> | void]> = [
      ['a new occurrence', async ({ app, world }) => {
        world.now = new Date('2026-10-04T13:00:00.000Z');
        await receive(app, 'slug-a');
      }],
      ['an added image', async ({ app }, id) => {
        expect((await app.request(`${DRAFTS}/${id}/images`, imagePost, LOCAL_ENV)).status).toBe(201);
      }],
      ['a moved pack version', ({ world }) => {
        world.latest = '9.9.9';
      }],
      ['a pack version that became unreadable', ({ world }) => {
        world.latest = undefined;
      }],
    ];

    it.each(changes)('does not stale If-Match after %s: the edit passes although the whole-body ETag moved', async (what, change) => {
      const ctx = setup();
      const { app, storage } = ctx;
      const id = await receive(app, 'slug-a');
      const stale = await etagOf(app, `${DRAFTS}/${id}`);
      await change(ctx, id);
      expect(await etagOf(app, `${DRAFTS}/${id}`), `${what} moves the ETag of the whole body`).not.toBe(stale);
      // 条件付き GET の相手は本文全体の版のまま: 古い ETag の If-None-Match には 304 ではなく新しい本文を返す。
      expect((await app.request(`${DRAFTS}/${id}`, read({ 'if-none-match': stale }), LOCAL_ENV)).status).toBe(200);
      const res = await app.request(`${DRAFTS}/${id}`, patch({ body: 'My body' }, { 'if-match': stale }), LOCAL_ENV);
      expect(res.status).toBe(200);
      expect(res.headers.get('ETag')).toBe(await etagOf(app, `${DRAFTS}/${id}`));
      expect(storage.drafts.get(id)).toMatchObject({ body: 'My body', bodyEditedByUser: true });
    });

    it('loses nothing the others changed: the count from the new occurrence and the added image are still there after the edit', async () => {
      const { app, world, storage, service } = setup();
      const id = await receive(app, 'slug-a');
      const stale = await etagOf(app, `${DRAFTS}/${id}`);
      world.now = new Date('2026-10-04T13:00:00.000Z');
      await receive(app, 'slug-a');
      expect((await app.request(`${DRAFTS}/${id}/images`, imagePost, LOCAL_ENV)).status).toBe(201);
      expect((await app.request(`${DRAFTS}/${id}`, patch({ title: 'Mine' }, { 'if-match': stale }), LOCAL_ENV)).status).toBe(200);
      expect(storage.drafts.get(id)).toMatchObject({ title: 'Mine', occurrenceCount: 2, lastOccurredAt: '2026-10-04T13:00:00.000Z' });
      expect(await service.listImages(id)).toHaveLength(1);
    });

    // 直していない欄の自動の文は、新しい発生で作り直される。古い版を読んだ画面の編集が、それを古い文で上書きしない。
    it('keeps what the new occurrence rebuilt in the field that was not edited (the stale text is not written back)', async () => {
      const { app, world, storage } = setup();
      const id = await receive(app, 'slug-a');
      expect((await app.request(`${DRAFTS}/${id}`, patch({ title: 'Mine' }), LOCAL_ENV)).status).toBe(200);
      const stale = await etagOf(app, `${DRAFTS}/${id}`);
      const oldBody = storage.drafts.get(id)?.body;
      world.now = new Date('2026-10-04T13:00:00.000Z');
      await receive(app, 'slug-a');
      const rebuiltBody = storage.drafts.get(id)?.body;
      expect(rebuiltBody).not.toBe(oldBody);
      const res = await app.request(`${DRAFTS}/${id}`, patch({ title: 'Mine, again' }, { 'if-match': stale }), LOCAL_ENV);
      expect(res.status).toBe(200);
      expect(storage.drafts.get(id)).toMatchObject({ title: 'Mine, again', body: rebuiltBody, occurrenceCount: 2, bodyEditedByUser: false });
    });

    it('passes for the tunnel reader too, with the ETag it read (the restricted form)', async () => {
      const { app, world, storage } = setup({ writeAccess: TUNNEL_WRITE_ALLOWED });
      const id = await receive(app, 'slug-a');
      const stale = await etagOf(app, `${DRAFTS}/${id}`, LOCAL_ENV, CF_HEADERS);
      world.now = new Date('2026-10-04T13:00:00.000Z');
      await receive(app, 'slug-a');
      const res = await app.request(`${DRAFTS}/${id}`, patch({ title: 'From the tunnel' }, { ...CF_HEADERS, 'if-match': stale }), LOCAL_ENV);
      expect(res.status).toBe(200);
      expect(res.headers.get('ETag')).toBe(await etagOf(app, `${DRAFTS}/${id}`, LOCAL_ENV, CF_HEADERS));
      expect(storage.drafts.get(id)).toMatchObject({ title: 'From the tunnel', occurrenceCount: 2 });
    });
  });

  // 直せる欄 (題名・本文の文と「直した」印) が読んだあとにほかで変わったときは、従来どおり 412 で、何も書かない。
  describe('a change in an edited field elsewhere', () => {
    it('answers 412 when the title was edited, the body was edited, or a field was put back to automatic', async () => {
      const { app, storage } = setup();
      const id = await receive(app, 'slug-a');
      const staleAfter = async (what: string, elsewhere: object) => {
        const stale = await etagOf(app, `${DRAFTS}/${id}`);
        expect((await app.request(`${DRAFTS}/${id}`, patch(elsewhere), LOCAL_ENV)).status).toBe(200);
        const before = structuredClone(storage.drafts.get(id));
        const res = await app.request(`${DRAFTS}/${id}`, patch({ body: 'Mine' }, { 'if-match': stale }), LOCAL_ENV);
        expect(res.status, what).toBe(412);
        expect(storage.drafts.get(id), what).toEqual(before);
      };
      await staleAfter('the title edited for the first time', { title: 'Edited elsewhere' });
      await staleAfter('the title edited again', { title: 'Edited elsewhere again' });
      await staleAfter('the body edited for the first time', { body: 'Body elsewhere' });
      await staleAfter('the body edited again', { body: 'Body elsewhere again' });
      await staleAfter('the title put back to automatic', { title: '' });
      await staleAfter('the body put back to automatic', { body: '' });
    });

    it('answers 412 even after a new occurrence moved the rest, and the 412 writes nothing', async () => {
      const { app, world, storage } = setup();
      const id = await receive(app, 'slug-a');
      const stale = await etagOf(app, `${DRAFTS}/${id}`);
      expect((await app.request(`${DRAFTS}/${id}`, patch({ title: 'Edited elsewhere' }), LOCAL_ENV)).status).toBe(200);
      world.now = new Date('2026-10-04T13:00:00.000Z');
      await receive(app, 'slug-a');
      const before = structuredClone(storage.drafts.get(id));
      expect((await app.request(`${DRAFTS}/${id}`, patch({ title: 'Mine' }, { 'if-match': stale }), LOCAL_ENV)).status).toBe(412);
      expect(storage.drafts.get(id)).toEqual(before);
    });
  });

  it('answers 404 for an unknown draft and 409 for a dismissed one before judging If-Match, and 400 for a bad body', async () => {
    const { app } = setup();
    const id = await receive(app, 'slug-a');
    const stale = await etagOf(app, `${DRAFTS}/${id}`);
    const headers = { 'if-match': stale };
    expect((await app.request(`${DRAFTS}/1758812349999-ffffffffffffffff`, patch({ title: 'x' }, headers), LOCAL_ENV)).status).toBe(404);
    expect((await app.request(`${DRAFTS}/${id}`, patch({ nope: 1 }, headers), LOCAL_ENV)).status).toBe(400);
    expect((await app.request(`${DRAFTS}/${id}/dismiss`, patch({ reason: 'not a bug' }), LOCAL_ENV)).status).toBe(200);
    const res = await app.request(`${DRAFTS}/${id}`, patch({ title: 'x' }, headers), LOCAL_ENV);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'draft is not pending', status: 'dismissed' });
  });

  it('answers 200 without an ETag, not 500, when the image list for the ETag cannot be read after the edit was saved', async () => {
    const { app, service, storage } = setup();
    const id = await receive(app, 'slug-a');
    const broken = createIssueReportRoutes({
      service: {
        ...service,
        listImages: () => {
          throw new Error('image directory unreadable');
        },
      },
    });
    const res = await broken.request(`${DRAFTS}/${id}`, patch({ title: 'Saved anyway' }), LOCAL_ENV);
    expect(res.status).toBe(200);
    expect(res.headers.get('ETag')).toBeNull();
    const body = (await res.json()) as { draft: { title: string }; errorTextTrimmed: boolean };
    expect(body.draft.title).toBe('Saved anyway');
    expect(body.errorTextTrimmed).toBe(false);
    expect(storage.drafts.get(id)?.title).toBe('Saved anyway');
  });

  it('lets exactly one of two edits made from the same ETag through, never both (the check runs inside the write lock)', async () => {
    const { app, storage } = setup();
    const id = await receive(app, 'slug-a');
    const etag = await etagOf(app, `${DRAFTS}/${id}`);
    const [first, second] = await Promise.all([
      app.request(`${DRAFTS}/${id}`, patch({ title: 'From the first tab' }, { 'if-match': etag }), LOCAL_ENV),
      app.request(`${DRAFTS}/${id}`, patch({ title: 'From the second tab' }, { 'if-match': etag }), LOCAL_ENV),
    ]);
    expect([first.status, second.status].sort()).toEqual([200, 412]);
    const winner = first.status === 200 ? 'From the first tab' : 'From the second tab';
    expect(storage.drafts.get(id)?.title).toBe(winner);
  });
});

describe('the ETag with the write guard, Basic auth and gzip', () => {
  it('leaves the write guard first: a refused write is 403 whatever If-Match says, and a stale If-Match changes nothing for it', async () => {
    const closed = setup();
    const id = await receive(closed.app, 'slug-a');
    const etag = await etagOf(closed.app, `${DRAFTS}/${id}`);
    const stale = WRONG_ETAG;
    expect((await closed.app.request(`${DRAFTS}/${id}`, patch({ title: 'x' }, { ...CF_HEADERS, 'if-match': stale }), LOCAL_ENV)).status).toBe(403);
    expect((await closed.app.request(`${DRAFTS}/${id}`, patch({ title: 'x' }, { 'sec-fetch-site': 'cross-site', 'if-match': etag }), LOCAL_ENV)).status).toBe(403);
    expect(closed.storage.drafts.get(id)?.titleEditedByUser).toBe(false);

    // トンネルの強パスワード + セッションなら通り、その読み手が見た (絞った形の) ETag で判定する。
    const open = setup({ writeAccess: TUNNEL_WRITE_ALLOWED });
    const openId = await receive(open.app, 'slug-a');
    const tunnelEtag = await etagOf(open.app, `${DRAFTS}/${openId}`, LOCAL_ENV, CF_HEADERS);
    expect((await open.app.request(`${DRAFTS}/${openId}`, patch({ title: 'x' }, { ...CF_HEADERS, 'if-match': stale }), LOCAL_ENV)).status).toBe(412);
    const allowed = await open.app.request(`${DRAFTS}/${openId}`, patch({ title: 'x' }, { ...CF_HEADERS, 'if-match': tunnelEtag }), LOCAL_ENV);
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get('ETag')).toBe(await etagOf(open.app, `${DRAFTS}/${openId}`, LOCAL_ENV, CF_HEADERS));
  });

  it('answers 401, not 304, to a request without a valid Basic auth even when If-None-Match matches', async () => {
    const { router } = setup();
    const app = new Hono();
    app.use('*', createBasicAuthMiddleware({ kind: 'enabled', config: { username: 'example-user', password: 'example-password' } }));
    app.route('/', router);
    const authorization = (password: string) => `Basic ${Buffer.from(`example-user:${password}`).toString('base64')}`;
    const etag = await etagOf(app, DRAFTS, {}, { authorization: authorization('example-password') });
    expect((await app.request(DRAFTS, read({ 'if-none-match': etag }), {})).status).toBe(401);
    expect((await app.request(DRAFTS, read({ 'if-none-match': etag, authorization: authorization('wrong-pass') }), {})).status).toBe(401);
    expect((await app.request(DRAFTS, read({ 'if-none-match': etag, authorization: authorization('example-password') }), {})).status).toBe(304);
  });

  it('works through the gzip middleware, which turns the strong ETag into W/"…": 304 and If-Match still match', async () => {
    const { app } = setup({ compression: true });
    const id = await receive(app, 'slug-a');
    const gzip = { 'accept-encoding': 'gzip' };
    const first = await app.request(`${DRAFTS}/${id}`, read(gzip), LOCAL_ENV);
    expect(first.headers.get('Content-Encoding')).toBe('gzip');
    const weak = first.headers.get('ETag') as string;
    expect(weak).toMatch(/^W\/"[0-9a-f]{32}-[0-9a-f]{32}"$/);
    expect((await app.request(`${DRAFTS}/${id}`, read({ ...gzip, 'if-none-match': weak }), LOCAL_ENV)).status).toBe(304);
    const edited = await app.request(`${DRAFTS}/${id}`, patch({ title: 'Edited' }, { ...gzip, 'if-match': weak }), LOCAL_ENV);
    expect(edited.status).toBe(200);
    const next = edited.headers.get('ETag') as string;
    expect(next).not.toBe(weak);
    expect((await app.request(`${DRAFTS}/${id}`, patch({ title: 'Again' }, { ...gzip, 'if-match': weak }), LOCAL_ENV)).status).toBe(412);
    expect((await app.request(`${DRAFTS}/${id}`, patch({ title: 'Again' }, { ...gzip, 'if-match': next }), LOCAL_ENV)).status).toBe(200);
  });
});
