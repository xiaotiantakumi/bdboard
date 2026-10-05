import { describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import { createIssueDraftService } from '../../application/issue-report/issue-draft-service.js';
import {
  createInMemoryIssueDraftStorage,
  type InMemoryIssueDraftStorage,
} from '../../application/issue-report/issue-draft-test-support.js';
import { createIssueReportRoutes } from './issue-report-routes.js';
import { ISSUE_DRAFT_EDIT_BODY_MAX_BYTES } from './issue-report-edit-routes.js';
import type { WriteGuardDeps } from './write-guard.js';

/** bdboard-4y8q.3.1: PATCH drafts/:id (題名・本文の編集) と未処理件数・最新の版 (HTTP の形)。 */

const LOCAL_ENV = { incoming: { socket: { remoteAddress: '127.0.0.1', localPort: 8787 } } };
const LOCAL_HOST = 'localhost:8787';
const CF_HEADERS = { 'cf-ray': 'abc123-NRT', 'cf-connecting-ip': '203.0.113.9' } as const;
const DRAFTS = '/api/issue-reports/drafts';
const PENDING_COUNT = '/api/issue-reports/pending-count';
const PROJECT_PATH = '/Users/example-user/src/example-project';

/** 強パスワードのトンネル + 有効なセッション Cookie を持つ書き込み許可 (write-guard が通す側)。 */
const TUNNEL_WRITE_ALLOWED: WriteGuardDeps = { isTunnelWriteAllowed: () => true, hasTunnelSession: () => true };

interface Setup {
  readonly app: Hono;
  readonly storage: InMemoryIssueDraftStorage;
}

function setup(options: { writeAccess?: WriteGuardDeps; latest?: () => Promise<string | undefined> } = {}): Setup {
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
  const app = createIssueReportRoutes({
    service,
    ...(options.writeAccess !== undefined ? { writeAccess: options.writeAccess } : {}),
    ...(options.latest !== undefined ? { latestHarnessVersion: options.latest } : {}),
  });
  return { app, storage };
}

function request(method: string, body: unknown, headers: Record<string, string> = {}): RequestInit {
  return {
    method,
    headers: { 'content-type': 'application/json', host: LOCAL_HOST, ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  };
}

const patch = (body: unknown, headers: Record<string, string> = {}) => request('PATCH', body, headers);

async function createDraft(app: Hono, slug = 'slug-a'): Promise<string> {
  const res = await app.request(
    DRAFTS,
    request('POST', {
      kind: 'A',
      catalogSlug: slug,
      envInfo: { bdboardVersion: '0.1.2', harnessVersion: '0.50.0', os: 'darwin', nodeVersion: 'v22.14.0' },
      project: { name: 'example-project', path: PROJECT_PATH },
    }),
    LOCAL_ENV,
  );
  expect(res.status).toBe(201);
  return ((await res.json()) as { draft: { id: string } }).draft.id;
}

interface EditedDraft {
  readonly title: string;
  readonly body: string;
  readonly titleEditedByUser: boolean;
  readonly bodyEditedByUser: boolean;
  readonly restricted: boolean;
  readonly suspectedLeaks?: ReadonlyArray<{ field: string; kind: string; start: number; end: number }>;
}

describe('PATCH /api/issue-reports/drafts/:id — the fields it writes', () => {
  it('writes title and body, sets the edited flags itself, and returns the detail with the re-run leak scan', async () => {
    const { app, storage } = setup();
    const id = await createDraft(app);
    const body = `cwd ${PROJECT_PATH}`;
    const res = await app.request(`${DRAFTS}/${id}`, patch({ title: '  My title  ', body }), LOCAL_ENV);
    expect(res.status).toBe(200);
    const { draft } = (await res.json()) as { draft: EditedDraft };
    expect(draft).toMatchObject({ title: 'My title', body, titleEditedByUser: true, bodyEditedByUser: true, restricted: false });
    expect(draft.suspectedLeaks?.some((leak) => leak.kind === 'project-path')).toBe(true);
    expect(storage.drafts.get(id)?.suspectedLeaks).toEqual(draft.suspectedLeaks);
  });

  it('accepts only one of the two fields and leaves the other as it was', async () => {
    const { app, storage } = setup();
    const id = await createDraft(app);
    const title = storage.drafts.get(id)?.title;
    expect((await app.request(`${DRAFTS}/${id}`, patch({ body: 'just the body' }), LOCAL_ENV)).status).toBe(200);
    expect(storage.drafts.get(id)).toMatchObject({ title, body: 'just the body', titleEditedByUser: false });
  });

  it('400s any other key (the edited flags, status, counts), an empty edit, a non-string and a multi-line title', async () => {
    const { app, storage } = setup();
    const id = await createDraft(app);
    const before = structuredClone(storage.drafts.get(id));
    for (const body of [
      { title: 't', titleEditedByUser: false },
      { body: 'b', bodyEditedByUser: true },
      { title: 't', status: 'posted' },
      { body: 'b', issueNumber: 1, issueUrl: 'https://example.invalid/1' },
      { body: 'b', occurrenceCount: 99 },
      { dismissReason: 'x' },
      {},
      { title: 1 },
      { body: null },
      { title: 'two\nlines' },
      { title: '​ ‍' },
      '{nope',
    ]) {
      const res = await app.request(`${DRAFTS}/${id}`, patch(body), LOCAL_ENV);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'invalid request body' });
    }
    expect(storage.drafts.get(id)).toEqual(before);
  });

  it('413s a title or body over the length cap before the service, and a request over the byte cap before reading it', async () => {
    const { app, storage } = setup();
    const id = await createDraft(app);
    const before = structuredClone(storage.drafts.get(id));
    const longTitle = await app.request(`${DRAFTS}/${id}`, patch({ title: 't'.repeat(257) }), LOCAL_ENV);
    expect(longTitle.status).toBe(413);
    expect(await longTitle.json()).toMatchObject({ code: 'too-long', maxTitleChars: 256, maxBodyChars: 65_536 });
    expect((await app.request(`${DRAFTS}/${id}`, patch({ body: 'b'.repeat(65_537) }), LOCAL_ENV)).status).toBe(413);
    const huge = await app.request(
      `${DRAFTS}/${id}`,
      patch({ body: 'b'.repeat(ISSUE_DRAFT_EDIT_BODY_MAX_BYTES) }),
      LOCAL_ENV,
    );
    expect(huge.status).toBe(413);
    expect(await huge.json()).toEqual({ error: 'request body too large' });
    expect(storage.drafts.get(id)).toEqual(before);
    // ちょうど上限は通る。
    expect((await app.request(`${DRAFTS}/${id}`, patch({ title: 't'.repeat(256), body: 'b'.repeat(65_536) }), LOCAL_ENV)).status).toBe(200);
  });

  it('413s (draft-too-large) a body within the length cap that would still push draft.json over 200KB, instead of a 500', async () => {
    const { app } = setup();
    const id = await createDraft(app);
    const res = await app.request(`${DRAFTS}/${id}`, patch({ body: '\u0001'.repeat(65_536) }), LOCAL_ENV);
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: 'draft would exceed the size limit', code: 'draft-too-large' });
  });

  it('409s a dismissed draft, 404s an unknown one and 400s a malformed id', async () => {
    const { app, storage } = setup();
    const id = await createDraft(app);
    expect((await app.request(`${DRAFTS}/${id}/dismiss`, patch({ reason: 'not a bug' }), LOCAL_ENV)).status).toBe(200);
    const res = await app.request(`${DRAFTS}/${id}`, patch({ title: 'x' }), LOCAL_ENV);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'draft is not pending', status: 'dismissed' });
    expect(storage.drafts.get(id)?.titleEditedByUser).toBe(false);
    expect((await app.request(`${DRAFTS}/1758812349999-ffffffffffffffff`, patch({ title: 'x' }), LOCAL_ENV)).status).toBe(404);
    expect((await app.request(`${DRAFTS}/not-an-id`, patch({ title: 'x' }), LOCAL_ENV)).status).toBe(400);
  });
});

describe('PATCH /api/issue-reports/drafts/:id — through the tunnel', () => {
  it('follows the ordinary write-guard like dismiss: refused by default, allowed with a strong-password session', async () => {
    const closed = setup();
    const closedId = await createDraft(closed.app);
    const refused = await closed.app.request(`${DRAFTS}/${closedId}`, patch({ title: 'x' }, CF_HEADERS), LOCAL_ENV);
    expect(refused.status).toBe(403);
    expect(closed.storage.drafts.get(closedId)?.titleEditedByUser).toBe(false);

    const open = setup({ writeAccess: TUNNEL_WRITE_ALLOWED });
    const openId = await createDraft(open.app);
    const allowed = await open.app.request(`${DRAFTS}/${openId}`, patch({ title: 'x' }, CF_HEADERS), LOCAL_ENV);
    expect(allowed.status).toBe(200);
    expect(open.storage.drafts.get(openId)?.title).toBe('x');
  });

  it('answers the tunnel with the restricted detail: home paths folded, leaks re-run on the folded text, no raw log', async () => {
    const { app, storage } = setup({ writeAccess: TUNNEL_WRITE_ALLOWED });
    const id = await createDraft(app);
    const body = `cwd ${PROJECT_PATH}/x`;
    const res = await app.request(`${DRAFTS}/${id}`, patch({ body }, CF_HEADERS), LOCAL_ENV);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain('example-user');
    const { draft } = JSON.parse(text) as { draft: EditedDraft };
    expect(draft.restricted).toBe(true);
    expect(draft.body).toBe('cwd ~/src/example-project/x');
    // 位置は返した (畳んだ) 本文の位置。
    for (const leak of draft.suspectedLeaks ?? []) expect(draft.body.slice(leak.start, leak.end).length).toBeGreaterThan(0);
    expect(draft.suspectedLeaks?.some((leak) => draft.body.slice(leak.start, leak.end) === 'example-project')).toBe(true);
    // 保存したのは畳む前の本文と、その位置。
    expect(storage.drafts.get(id)?.body).toBe(body);
  });
});

describe('PATCH /api/issue-reports/drafts/:id — review follow-ups (bdboard-4y8q.3.1)', () => {
  it('drops a zero-width space and a BOM pasted into the title instead of refusing it', async () => {
    const { app, storage } = setup();
    const id = await createDraft(app);
    const res = await app.request(`${DRAFTS}/${id}`, patch({ title: '\u200BHello\uFEFF' }), LOCAL_ENV);
    expect(res.status).toBe(200);
    expect(storage.drafts.get(id)?.title).toBe('Hello');
  });

  it('refuses the tunnel with a weak password and a cookie, and with a strong password but no cookie (403)', async () => {
    for (const writeAccess of [
      { isTunnelWriteAllowed: () => false, hasTunnelSession: () => true },
      { isTunnelWriteAllowed: () => true, hasTunnelSession: () => false },
    ]) {
      const { app, storage } = setup({ writeAccess });
      const id = await createDraft(app);
      const res = await app.request(`${DRAFTS}/${id}`, patch({ title: 'x' }, CF_HEADERS), LOCAL_ENV);
      expect(res.status).toBe(403);
      expect(storage.drafts.get(id)?.titleEditedByUser).toBe(false);
    }
  });

  it('gives the tunnel no suspectedLeaks for a draft nobody has edited', async () => {
    const { app } = setup();
    const id = await createDraft(app);
    const res = await app.request(`${DRAFTS}/${id}`, { headers: { ...CF_HEADERS } }, LOCAL_ENV);
    const { draft } = (await res.json()) as { draft: Record<string, unknown> };
    expect(draft.restricted).toBe(true);
    expect(draft).not.toHaveProperty('suspectedLeaks');
  });

  it('answers a right and a wrong guess of the hidden project path the same way through the tunnel (M-1)', async () => {
    const hiddenPath = '/Users/alice/work/secret-proj';
    const answers = async (guess: string): Promise<string[]> => {
      const { app } = setup({ writeAccess: TUNNEL_WRITE_ALLOWED });
      const created = await app.request(
        DRAFTS,
        request('POST', { kind: 'A', catalogSlug: 'slug-a', project: { name: 'public-name', path: hiddenPath } }),
        LOCAL_ENV,
      );
      const { id } = ((await created.json()) as { draft: { id: string } }).draft;
      const patched = await app.request(`${DRAFTS}/${id}`, patch({ body: guess }, CF_HEADERS), LOCAL_ENV);
      const read = await app.request(`${DRAFTS}/${id}`, { headers: { ...CF_HEADERS } }, LOCAL_ENV);
      const leaksOf = async (res: Response) =>
        JSON.stringify(((await res.json()) as { draft: { suspectedLeaks?: unknown } }).draft.suspectedLeaks);
      return [await leaksOf(patched), await leaksOf(read)];
    };
    // 同じ長さの推測: 正しいパスとフォルダ名 / 外れたパスとフォルダ名。
    const right = await answers('x/Users/alice/work/secret-proj | secret-proj | public-name');
    const wrong = await answers('x/Users/carol/work/guessx-proj | guessx-proj | public-name');
    expect(right).toEqual(wrong);
    expect(right[0]).not.toContain('project-path');
    expect(right[0]).toContain('"kind":"project"'); // 見えている表示名は疑いに出る
  });

  it('trims only the raw error text to fit 200KB, says so, and keeps the projects (M-2)', async () => {
    const { app, storage } = setup({ writeAccess: TUNNEL_WRITE_ALLOWED });
    const created = await app.request(
      DRAFTS,
      request('POST', {
        kind: 'C',
        source: 'server',
        errorText: 'e'.repeat(60_000),
        symptom: 's'.repeat(8_000),
        project: { name: 'example-project', path: PROJECT_PATH },
      }),
      LOCAL_ENV,
    );
    const { id } = ((await created.json()) as { draft: { id: string } }).draft;
    const res = await app.request(`${DRAFTS}/${id}`, patch({ body: 'あ'.repeat(45_000) }, CF_HEADERS), LOCAL_ENV);
    expect(res.status).toBe(200);
    const payload = (await res.json()) as { errorTextTrimmed: boolean; draft: { localOnly: { errorTextTruncated: boolean } } };
    expect(payload.errorTextTrimmed).toBe(true);
    expect(payload.draft.localOnly.errorTextTruncated).toBe(true);
    const stored = storage.drafts.get(id);
    expect(stored?.occurredProjects).toHaveLength(1);
    expect(stored?.localOnly.symptomRaw).toHaveLength(8_000);
    expect((stored?.localOnly.errorTextRaw?.length ?? 0) < 60_000).toBe(true);

    const small = await app.request(`${DRAFTS}/${id}`, patch({ body: 'short' }, CF_HEADERS), LOCAL_ENV);
    expect(((await small.json()) as { errorTextTrimmed: boolean }).errorTextTrimmed).toBe(false);
  });
});

describe('pending count and the latest harness pack version', () => {
  it('GET pending-count and the list answer the number of pending drafts', async () => {
    const { app } = setup();
    const a = await createDraft(app, 'slug-a');
    await createDraft(app, 'slug-b');
    const count = async () => ((await (await app.request(PENDING_COUNT, { headers: { host: LOCAL_HOST } }, LOCAL_ENV)).json()) as { pendingCount: number }).pendingCount;
    expect(await count()).toBe(2);
    await app.request(`${DRAFTS}/${a}/dismiss`, patch({ reason: 'dup' }), LOCAL_ENV);
    expect(await count()).toBe(1);
    const list = (await (await app.request(DRAFTS, { headers: { host: LOCAL_HOST } }, LOCAL_ENV)).json()) as { pendingCount: number; drafts: unknown[] };
    expect(list.pendingCount).toBe(1);
    expect(list.drafts).toHaveLength(2);
  });

  it('GET pending-count is a read: the tunnel reads it like the list', async () => {
    const { app } = setup();
    await createDraft(app);
    const res = await app.request(PENDING_COUNT, { headers: { ...CF_HEADERS } }, LOCAL_ENV);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ pendingCount: 1 });
  });

  it('GET drafts/:id carries the latest harness pack version (null without a source or when it fails)', async () => {
    for (const [latest, expected] of [
      [() => Promise.resolve('0.57.0'), '0.57.0'],
      [() => Promise.resolve(undefined), null],
      [() => Promise.reject(new Error('EIO')), null],
      [undefined, null],
    ] as const) {
      const { app } = setup(latest === undefined ? {} : { latest });
      const id = await createDraft(app);
      const res = await app.request(`${DRAFTS}/${id}`, { headers: { host: LOCAL_HOST } }, LOCAL_ENV);
      expect(res.status).toBe(200);
      const payload = (await res.json()) as { latestHarnessVersion: unknown; draft: { harnessVersionAtOccurrence?: string } };
      expect(payload.latestHarnessVersion).toBe(expected);
      expect(payload.draft.harnessVersionAtOccurrence).toBe('0.50.0');
    }
  });
});
