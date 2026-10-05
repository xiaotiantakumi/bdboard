import { describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import { createIssueDraftService } from '../../application/issue-report/issue-draft-service.js';
import {
  createInMemoryIssueDraftStorage,
  type InMemoryIssueDraftStorage,
} from '../../application/issue-report/issue-draft-test-support.js';
import { ISSUE_DRAFT_FREE_TEXT_MAX_CHARS, ISSUE_DRAFT_NEW_PER_HOUR } from '../../domain/issue-draft.js';
import { ISSUE_DRAFT_MANUAL_PER_HOUR } from '../../domain/issue-draft-manual.js';
import { ISSUE_DRAFT_TITLE_MAX_CHARS } from '../../domain/issue-draft-edit.js';
import {
  createIssueReportManualRoutes,
  ISSUE_MANUAL_DRAFT_BODY_MAX_BYTES,
  ISSUE_MANUAL_DRAFTS_PATH,
} from './issue-report-manual-routes.js';
import { createIssueReportRoutes } from './issue-report-routes.js';
import type { WriteGuardDeps } from './write-guard.js';

/** bdboard-4y8q.6.7: POST /api/issue-reports/manual-drafts (人が手で書く下書き)。 */

const LOCAL_ENV = { incoming: { socket: { remoteAddress: '127.0.0.1', localPort: 8787 } } };
const TUNNEL_ENV = LOCAL_ENV;
const REMOTE_ENV = { incoming: { socket: { remoteAddress: '192.0.2.1', localPort: 8787 } } };
const LOCAL_HOST = 'localhost:8787';
const CF_HEADERS = { 'cf-ray': 'abc123-NRT', 'cf-connecting-ip': '203.0.113.9' } as const;
const PNG_BASE64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64');
const DRAFTS = '/api/issue-reports/drafts';
const ENV = { bdboardVersion: '0.1.2', os: 'darwin', nodeVersion: 'v22.14.0' };
const PROJECT_PATH = '/Users/example-user/src/example-project';

const TUNNEL_WRITE_ALLOWED: WriteGuardDeps = {
  isTunnelWriteAllowed: () => true,
  hasTunnelSession: () => true,
};

interface Setup {
  readonly app: Hono;
  readonly storage: InMemoryIssueDraftStorage;
}

/** wire-issue-reports.ts と同じ組み立て: 既存のルーターへ手書きのルートを載せる。 */
function setup(options: { writeAccess?: WriteGuardDeps; maxTotalBytes?: number } = {}): Setup {
  const storage = createInMemoryIssueDraftStorage();
  let seq = 0;
  const service = createIssueDraftService({
    storage,
    now: () => new Date('2026-10-04T12:00:00.000Z'),
    newId: () => {
      seq += 1;
      return `${1758812345000 + seq}-${seq.toString(16).padStart(16, '0')}`;
    },
    envInfo: () => ENV,
    ...(options.maxTotalBytes !== undefined ? { retention: { maxTotalBytes: options.maxTotalBytes } } : {}),
  });
  const app = createIssueReportRoutes({ service, ...(options.writeAccess !== undefined ? { writeAccess: options.writeAccess } : {}) });
  app.route('/', createIssueReportManualRoutes({ service }));
  return { app, storage };
}

function json(body: unknown, headers: Record<string, string> = {}): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json', host: LOCAL_HOST, ...headers },
    body: JSON.stringify(body),
  };
}

const BODY = { title: 'The board hangs', description: 'it froze when I opened the tab' };

const postManual = (app: Hono, body: unknown = BODY, headers: Record<string, string> = {}) =>
  app.request(ISSUE_MANUAL_DRAFTS_PATH, json(body, headers), LOCAL_ENV);

interface CreatedBody {
  readonly outcome: string;
  readonly draft: { readonly id: string; readonly fingerprint: string; readonly kind: string; readonly title: string };
}

async function createManual(app: Hono, body: unknown = BODY): Promise<CreatedBody> {
  const res = await postManual(app, body);
  expect(res.status).toBe(201);
  return (await res.json()) as CreatedBody;
}

describe('POST /api/issue-reports/manual-drafts — create', () => {
  it('creates a draft (201) in the receive response shape and stores it as a kind C manual draft', async () => {
    const { app, storage } = setup();
    const res = await postManual(app);
    expect(res.status).toBe(201);
    const created = (await res.json()) as CreatedBody & { draft: Record<string, unknown> };
    expect(created.outcome).toBe('created');
    expect(created.draft).toMatchObject({ kind: 'C', status: 'pending', title: 'The board hangs', occurrenceCount: 1, occurredProjectCount: 0 });
    expect(created.draft.fingerprint).toMatch(/^C:manual:[0-9a-f]{16}$/);
    // 応答に説明 (手元の中身) は載せない。
    expect(JSON.stringify(created)).not.toContain('it froze');

    const stored = storage.drafts.get(created.draft.id);
    expect(stored).toMatchObject({ source: 'manual', titleEditedByUser: true, bodyEditedByUser: false });
    expect(stored?.localOnly.agentNoteRaw).toBe(BODY.description);
    expect(stored?.localOnly.envInfo).toEqual(ENV);
  });

  it('trims the title and drops pasted zero-width spaces and a BOM', async () => {
    const { app, storage } = setup();
    const created = await createManual(app, { ...BODY, title: '  \ufeffThe\u200b board hangs  ' });
    expect(storage.drafts.get(created.draft.id)?.title).toBe('The board hangs');
  });

  it('stores the same text sent twice as two separate drafts', async () => {
    const { app, storage } = setup();
    const first = await createManual(app);
    const second = await createManual(app);
    expect(second.draft.id).not.toBe(first.draft.id);
    expect(second.draft.fingerprint).not.toBe(first.draft.fingerprint);
    expect(storage.drafts.size).toBe(2);
  });

  it('accepts a description of exactly 8000 characters made of control characters (JSON escapes still fit the 64KB body limit)', async () => {
    const { app, storage } = setup();
    const description = `x${'\u0001'.repeat(ISSUE_DRAFT_FREE_TEXT_MAX_CHARS - 1)}`;
    const body = JSON.stringify({ title: 'big', description });
    expect(Buffer.byteLength(body)).toBeLessThan(ISSUE_MANUAL_DRAFT_BODY_MAX_BYTES);
    const created = await createManual(app, { title: 'big', description });
    expect(storage.drafts.get(created.draft.id)?.localOnly.agentNoteRaw).toBe(description);
  });

  it('accepts a 256-character title', async () => {
    const { app } = setup();
    await createManual(app, { ...BODY, title: 'a'.repeat(ISSUE_DRAFT_TITLE_MAX_CHARS) });
  });
});

describe('POST /api/issue-reports/manual-drafts — the limit (default 20 per hour, apart from the automatic 20)', () => {
  it('creates 20 drafts and answers 429 manual-rate-limited for the 21st, storing nothing more', async () => {
    const { app, storage } = setup();
    for (let n = 0; n < ISSUE_DRAFT_MANUAL_PER_HOUR; n += 1) await createManual(app, { ...BODY, title: `title ${n}` });

    const res = await postManual(app);
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: 'too many manual reports in the last hour', code: 'manual-rate-limited' });
    expect(storage.drafts.size).toBe(ISSUE_DRAFT_MANUAL_PER_HOUR);
  });

  it('lets the automatic receive create a new draft after 20 manual drafts (the limit is not shared)', async () => {
    const { app, storage } = setup();
    for (let n = 0; n < ISSUE_DRAFT_MANUAL_PER_HOUR; n += 1) await createManual(app, { ...BODY, title: `title ${n}` });

    const res = await app.request(DRAFTS, json({ kind: 'B', source: 'hook.sh', symptom: 's', envInfo: ENV }), LOCAL_ENV);
    expect(res.status).toBe(201);
    expect(((await res.json()) as { outcome: string }).outcome).toBe('created');
    expect(storage.drafts.size).toBe(ISSUE_DRAFT_MANUAL_PER_HOUR + 1);
  });

  it('still creates a manual draft when the automatic limit is used up (answers 201, not folded)', async () => {
    const { app, storage } = setup();
    for (let n = 0; n <= ISSUE_DRAFT_NEW_PER_HOUR; n += 1) {
      await app.request(DRAFTS, json({ kind: 'B', source: `hook-${n}.sh`, symptom: 's', envInfo: ENV }), LOCAL_ENV);
    }
    const before = storage.drafts.size;
    const created = await createManual(app);
    expect(created.outcome).toBe('created');
    expect(storage.drafts.size).toBe(before + 1);
  });

  it('answers 507 storage-full when the total size cap does not fit the draft', async () => {
    const { app, storage } = setup({ maxTotalBytes: 100 });
    const res = await postManual(app);
    expect(res.status).toBe(507);
    expect(await res.json()).toEqual({ error: 'issue draft storage is full', code: 'storage-full' });
    expect(storage.drafts.size).toBe(0);
  });
});

describe('POST /api/issue-reports/manual-drafts — local direct access only (tunnel is rejected)', () => {
  it.each([
    ['a cf-ray header (cloudflared forwards from 127.0.0.1)', json(BODY, CF_HEADERS), TUNNEL_ENV],
    ['only a cf-connecting-ip header', json(BODY, { 'cf-connecting-ip': '203.0.113.9' }), TUNNEL_ENV],
    ['only a cf-visitor header', json(BODY, { 'cf-visitor': '{"scheme":"https"}' }), TUNNEL_ENV],
    ['a non-loopback TCP source', json(BODY), REMOTE_ENV],
    ['a Host header that is not loopback (DNS rebinding)', json(BODY, { host: 'attacker.example:8787' }), LOCAL_ENV],
    ['no socket information at all', json(BODY), {}],
  ])('rejects %s with 403 and stores nothing', async (_label, init, env) => {
    const { app, storage } = setup();
    const res = await app.request(ISSUE_MANUAL_DRAFTS_PATH, init, env);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'local access only' });
    expect(storage.drafts.size).toBe(0);
  });

  it('rejects the tunnel even when write-guard would let that tunnel session write (strong password + valid cookie)', async () => {
    const { app, storage } = setup({ writeAccess: TUNNEL_WRITE_ALLOWED });
    const viaTunnel = await app.request(ISSUE_MANUAL_DRAFTS_PATH, json(BODY, CF_HEADERS), TUNNEL_ENV);
    expect(viaTunnel.status).toBe(403);
    expect(await viaTunnel.json()).toEqual({ error: 'local access only' });
    expect(storage.drafts.size).toBe(0);

    // 同じ設定で、ローカル直アクセスは通る (許可つきの setup 自体が止めているのではない)。
    expect((await postManual(setup({ writeAccess: TUNNEL_WRITE_ALLOWED }).app)).status).toBe(201);
  });

  it('rejects a cross-site or form-typed POST from the local machine (CSRF layers stay on)', async () => {
    const { app, storage } = setup();
    expect((await postManual(app, BODY, { 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    const form = await app.request(
      ISSUE_MANUAL_DRAFTS_PATH,
      { method: 'POST', headers: { 'content-type': 'text/plain', host: LOCAL_HOST }, body: JSON.stringify(BODY) },
      LOCAL_ENV,
    );
    expect(form.status).toBe(403);
    expect(storage.drafts.size).toBe(0);
  });
});

describe('POST /api/issue-reports/manual-drafts — input validation (400 with a fixed message, 413 over 64KB)', () => {
  it.each<[string, unknown]>([
    ['no body fields', {}],
    ['a missing title', { description: 'd' }],
    ['a missing description', { title: 't' }],
    ['a non-string title', { title: 1, description: 'd' }],
    ['an empty title', { title: '', description: 'd' }],
    ['a whitespace-only title', { title: '   ', description: 'd' }],
    ['a title of only invisible characters', { title: '\u200b⠀', description: 'd' }],
    ['a two-line title', { title: 'a\nb', description: 'd' }],
    ['a title with a trailing newline', { title: 'abc\n', description: 'd' }],
    ['a title with a control character', { title: 'a\u0007b', description: 'd' }],
    ['a title with a bidi control character', { title: 'a\u202eb', description: 'd' }],
    ['a 257-character title', { title: 'a'.repeat(ISSUE_DRAFT_TITLE_MAX_CHARS + 1), description: 'd' }],
    ['an empty description', { title: 't', description: '' }],
    ['a whitespace-only description', { title: 't', description: ' \n\t ' }],
    ['a 8001-character description', { title: 't', description: 'x'.repeat(ISSUE_DRAFT_FREE_TEXT_MAX_CHARS + 1) }],
    ['a non-object project', { title: 't', description: 'd', project: 'p' }],
    ['a project without a path', { title: 't', description: 'd', project: { name: 'p' } }],
  ])('rejects %s with 400 and stores nothing', async (_label, body) => {
    const { app, storage } = setup();
    const res = await postManual(app, body);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid request body' });
    expect(storage.drafts.size).toBe(0);
  });

  it('does not echo the rejected input back', async () => {
    const { app } = setup();
    const res = await postManual(app, { title: 'secret-token-123\nsecond line', description: 'd' });
    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain('secret-token-123');
  });

  it('rejects a body that is not JSON with 400', async () => {
    const { app } = setup();
    const res = await app.request(
      ISSUE_MANUAL_DRAFTS_PATH,
      { method: 'POST', headers: { 'content-type': 'application/json', host: LOCAL_HOST }, body: '{not json' },
      LOCAL_ENV,
    );
    expect(res.status).toBe(400);
  });

  it('caps the body at 64KB: 65537 bytes answers 413 and stores nothing', async () => {
    const { app, storage } = setup();
    expect(ISSUE_MANUAL_DRAFT_BODY_MAX_BYTES).toBe(64 * 1024);
    const overLimit = JSON.stringify({ title: 't', description: 'x'.repeat(ISSUE_MANUAL_DRAFT_BODY_MAX_BYTES) });
    expect(Buffer.byteLength(overLimit)).toBeGreaterThan(ISSUE_MANUAL_DRAFT_BODY_MAX_BYTES);
    const res = await app.request(
      ISSUE_MANUAL_DRAFTS_PATH,
      { method: 'POST', headers: { 'content-type': 'application/json', host: LOCAL_HOST }, body: overLimit },
      LOCAL_ENV,
    );
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: 'request body too large' });
    expect(storage.drafts.size).toBe(0);
  });
});

describe('POST /api/issue-reports/manual-drafts — title leak check and the hand-only description', () => {
  async function detail(app: Hono, id: string, init: RequestInit = { headers: { host: LOCAL_HOST } }, env = LOCAL_ENV) {
    const res = await app.request(`${DRAFTS}/${id}`, init, env);
    expect(res.status).toBe(200);
    return (await res.json()) as {
      draft: {
        title: string;
        body: string;
        restricted: boolean;
        titleEditedByUser: boolean;
        suspectedLeaks?: ReadonlyArray<{ field: string; kind: string; start: number; end: number }>;
        localOnly: { agentNoteRaw?: string };
      };
      images: ReadonlyArray<{ fileName: string }>;
    };
  }

  it('flags a project name written in the title', async () => {
    const { app } = setup();
    const created = await createManual(app, {
      title: 'example-project crashes on start',
      description: 'd',
      project: { name: 'example-project', path: PROJECT_PATH },
    });
    const { draft } = await detail(app, created.draft.id);
    expect(draft.titleEditedByUser).toBe(true);
    expect(draft.suspectedLeaks?.some((leak) => leak.field === 'title' && leak.kind === 'project')).toBe(true);
  });

  it('flags a home path written in the title even when no project was sent, and flags nothing in a plain title', async () => {
    const { app } = setup();
    const leaky = await createManual(app, { title: `cwd ${PROJECT_PATH}`, description: 'd' });
    expect((await detail(app, leaky.draft.id)).draft.suspectedLeaks?.some((leak) => leak.field === 'title')).toBe(true);
    const plain = await createManual(app);
    expect((await detail(app, plain.draft.id)).draft.suspectedLeaks).toEqual([]);
  });

  it('keeps the description out of the provisional public body, and hides it from the tunnel reader', async () => {
    const { app } = setup();
    const description = 'steps to reproduce: unique-marker-7f3a';
    const created = await createManual(app, { title: 'The board hangs', description });

    const local = await detail(app, created.draft.id);
    expect(local.draft.localOnly.agentNoteRaw).toBe(description);
    expect(local.draft.body).not.toContain('unique-marker-7f3a');
    expect(local.draft.title).not.toContain('unique-marker-7f3a');

    const tunnelRes = await app.request(`${DRAFTS}/${created.draft.id}`, { headers: { ...CF_HEADERS } }, TUNNEL_ENV);
    expect(tunnelRes.status).toBe(200);
    expect(await tunnelRes.text()).not.toContain('unique-marker-7f3a');
  });

  it('lets the existing image API attach an image to the manual draft', async () => {
    const { app, storage } = setup();
    const created = await createManual(app);
    const res = await app.request(
      `${DRAFTS}/${created.draft.id}/images`,
      json({ mimeType: 'image/png', data: PNG_BASE64 }),
      LOCAL_ENV,
    );
    expect(res.status).toBe(201);
    expect(await storage.countImages(created.draft.id)).toBe(1);
    expect((await detail(app, created.draft.id)).images).toHaveLength(1);
  });

  it('lists the manual draft with the automatic ones, counted as pending', async () => {
    const { app } = setup();
    const created = await createManual(app);
    const res = await app.request(DRAFTS, { headers: { host: LOCAL_HOST } }, LOCAL_ENV);
    const list = (await res.json()) as { drafts: Array<{ id: string; fingerprint: string }>; pendingCount: number };
    expect(list.pendingCount).toBe(1);
    expect(list.drafts.map((draft) => draft.id)).toEqual([created.draft.id]);
  });
});
