import { describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import { createIssueDraftService, type IssueDraftService } from '../../application/issue-report/issue-draft-service.js';
import {
  createInMemoryIssueDraftStorage,
  type InMemoryIssueDraftStorage,
} from '../../application/issue-report/issue-draft-test-support.js';
import { ISSUE_DRAFT_MAX_IMAGES } from '../../domain/issue-draft.js';
import { ATTACHMENT_MAX_COUNT_PER_TICKET } from './attachment-validation.js';
import { createIssueReportRoutes, ISSUE_REPORT_BODY_MAX_BYTES } from './issue-report-routes.js';
import type { WriteGuardDeps } from './write-guard.js';

const LOCAL_ENV = { incoming: { socket: { remoteAddress: '127.0.0.1', localPort: 8787 } } };
const TUNNEL_ENV = { incoming: { socket: { remoteAddress: '127.0.0.1', localPort: 8787 } } };
const REMOTE_ENV = { incoming: { socket: { remoteAddress: '192.0.2.1', localPort: 8787 } } };
const LOCAL_HOST = 'localhost:8787';
const CF_HEADERS = { 'cf-ray': 'abc123-NRT', 'cf-connecting-ip': '203.0.113.9' } as const;
const PNG_BYTES = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
const PNG_BASE64 = Buffer.from(PNG_BYTES).toString('base64');
const DRAFTS = '/api/issue-reports/drafts';

/** 強パスワードのトンネル + 有効なセッション Cookie を持つ書き込み許可 (write-guard が通す側)。 */
const TUNNEL_WRITE_ALLOWED: WriteGuardDeps = {
  isTunnelWriteAllowed: () => true,
  hasTunnelSession: () => true,
};

interface Setup {
  readonly app: Hono;
  readonly service: IssueDraftService;
  readonly storage: InMemoryIssueDraftStorage;
}

function setup(writeAccess?: WriteGuardDeps): Setup {
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
  const app = createIssueReportRoutes({ service, ...(writeAccess !== undefined ? { writeAccess } : {}) });
  return { app, service, storage };
}

function json(body: unknown, headers: Record<string, string> = {}): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json', host: LOCAL_HOST, ...headers },
    body: JSON.stringify(body),
  };
}

function patchJson(body: unknown, headers: Record<string, string> = {}): RequestInit {
  return { ...json(body, headers), method: 'PATCH' };
}

function localGet(headers: Record<string, string> = {}): RequestInit {
  return { headers: { host: LOCAL_HOST, ...headers } };
}

const DRAFT_BODY = {
  kind: 'B',
  source: 'stop-ticket-gate.sh',
  symptom: 'gate silently passed',
  errorText: 'jq: command not found',
  envInfo: { bdboardVersion: '0.1.2', os: 'darwin', nodeVersion: 'v22.14.0' },
  project: { name: 'example-project', path: '/Users/example-user/example-project' },
};

async function createDraft(app: Hono, body: unknown = DRAFT_BODY): Promise<{ id: string; status: number }> {
  const res = await app.request(DRAFTS, json(body), LOCAL_ENV);
  const payload = (await res.json()) as { draft?: { id: string } };
  return { id: payload.draft?.id ?? '', status: res.status };
}

describe('POST /api/issue-reports/drafts — receive', () => {
  it('creates a draft (201) and merges a repeat of the same fingerprint (200)', async () => {
    const { app, storage } = setup();
    const first = await app.request(DRAFTS, json(DRAFT_BODY), LOCAL_ENV);
    expect(first.status).toBe(201);
    const created = (await first.json()) as { outcome: string; draft: Record<string, unknown> };
    expect(created.outcome).toBe('created');
    expect(created.draft).toMatchObject({ kind: 'B', status: 'pending', occurrenceCount: 1 });
    // 受け取りの応答に手元限定の中身 (生ログ・パス) は載せない。
    expect(JSON.stringify(created)).not.toContain('example-user');
    expect(JSON.stringify(created)).not.toContain('jq: command not found');

    const second = await app.request(DRAFTS, json(DRAFT_BODY), LOCAL_ENV);
    expect(second.status).toBe(200);
    const merged = (await second.json()) as { outcome: string; draft: { id: string; occurrenceCount: number } };
    expect(merged.outcome).toBe('merged');
    expect(merged.draft.id).toBe((created.draft as { id: string }).id);
    expect(merged.draft.occurrenceCount).toBe(2);
    expect(storage.drafts.size).toBe(1);
  });

  it('reports a fold into the 大量発生 draft as 200 + outcome "folded"', async () => {
    const { app } = setup();
    for (let index = 0; index < 20; index += 1) {
      const res = await app.request(DRAFTS, json({ kind: 'A', catalogSlug: `slug-${index}` }), LOCAL_ENV);
      expect(res.status).toBe(201);
    }
    const res = await app.request(DRAFTS, json({ kind: 'A', catalogSlug: 'slug-over' }), LOCAL_ENV);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { outcome: string }).outcome).toBe('folded');
  });

  it('400s a body that is not valid JSON, has an unknown kind, or cannot be fingerprinted', async () => {
    const { app, storage } = setup();
    const notJson = await app.request(
      DRAFTS,
      { method: 'POST', headers: { 'content-type': 'application/json', host: LOCAL_HOST }, body: '{nope' },
      LOCAL_ENV,
    );
    expect(notJson.status).toBe(400);
    expect((await app.request(DRAFTS, json({ kind: 'Z', source: 's' }), LOCAL_ENV)).status).toBe(400);
    expect((await app.request(DRAFTS, json({ kind: 'A' }), LOCAL_ENV)).status).toBe(400);
    expect((await app.request(DRAFTS, json({ kind: 'B', errorText: 'x' }), LOCAL_ENV)).status).toBe(400);
    expect(storage.drafts.size).toBe(0);
  });

  it('413s a body over the receive limit before reading it', async () => {
    const { app } = setup();
    const res = await app.request(
      DRAFTS,
      json({ kind: 'C', source: 's', errorText: 'x'.repeat(ISSUE_REPORT_BODY_MAX_BYTES + 1) }),
      LOCAL_ENV,
    );
    expect(res.status).toBe(413);
  });

  it('truncates a very long error text instead of rejecting the report', async () => {
    const { app, storage } = setup();
    const res = await app.request(
      DRAFTS,
      json({ kind: 'C', source: 's', errorText: 'e'.repeat(300_000) }),
      LOCAL_ENV,
    );
    expect(res.status).toBe(201);
    const [draft] = [...storage.drafts.values()];
    expect(draft.localOnly.errorTextRaw?.length).toBeLessThan(300_000);
    expect(draft.localOnly.errorTextTruncated).toBe(true);
  });
});

describe('POST /api/issue-reports/drafts — local direct access only (tunnel is rejected)', () => {
  it.each([
    ['a cf-ray header (cloudflared forwards from 127.0.0.1)', json(DRAFT_BODY, CF_HEADERS), TUNNEL_ENV],
    ['only a cf-connecting-ip header', json(DRAFT_BODY, { 'cf-connecting-ip': '203.0.113.9' }), TUNNEL_ENV],
    ['only a cf-visitor header', json(DRAFT_BODY, { 'cf-visitor': '{"scheme":"https"}' }), TUNNEL_ENV],
    ['a non-loopback TCP source', json(DRAFT_BODY), REMOTE_ENV],
    ['a Host header that is not loopback (DNS rebinding)', json(DRAFT_BODY, { host: 'attacker.example:8787' }), LOCAL_ENV],
    ['no socket information at all', json(DRAFT_BODY), {}],
  ])('rejects %s with 403 and stores nothing', async (_label, init, env) => {
    const { app, storage } = setup();
    const res = await app.request(DRAFTS, init, env);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'local access only' });
    expect(storage.drafts.size).toBe(0);
  });

  it('rejects the tunnel even when write-guard would let that tunnel session write (strong password + valid cookie)', async () => {
    const { app, storage } = setup(TUNNEL_WRITE_ALLOWED);
    const res = await app.request(DRAFTS, json(DRAFT_BODY, CF_HEADERS), TUNNEL_ENV);
    expect(res.status).toBe(403);
    expect(storage.drafts.size).toBe(0);
  });

  it('rejects a cross-site or form-typed POST from the local machine (CSRF layers stay on)', async () => {
    const { app, storage } = setup();
    const crossSite = await app.request(DRAFTS, json(DRAFT_BODY, { 'sec-fetch-site': 'cross-site' }), LOCAL_ENV);
    expect(crossSite.status).toBe(403);
    const form = await app.request(
      DRAFTS,
      { method: 'POST', headers: { 'content-type': 'text/plain', host: LOCAL_HOST }, body: JSON.stringify(DRAFT_BODY) },
      LOCAL_ENV,
    );
    expect(form.status).toBe(403);
    expect(storage.drafts.size).toBe(0);
  });

  it('applies to the image upload as well', async () => {
    const { app, storage } = setup();
    const { id } = await createDraft(app);
    const res = await app.request(
      `${DRAFTS}/${id}/images`,
      json({ mimeType: 'image/png', data: PNG_BASE64 }, CF_HEADERS),
      TUNNEL_ENV,
    );
    expect(res.status).toBe(403);
    expect(await storage.countImages(id)).toBe(0);
  });
});

describe('GET /api/issue-reports/drafts and /:id — screen API', () => {
  it('lists summaries (no body, no hand-only context), newest activity first', async () => {
    const { app } = setup();
    await createDraft(app, { kind: 'A', catalogSlug: 'first' });
    await createDraft(app, DRAFT_BODY);

    const res = await app.request(DRAFTS, localGet(), LOCAL_ENV);
    expect(res.status).toBe(200);
    const payload = (await res.json()) as { drafts: Array<Record<string, unknown>> };
    expect(payload.drafts).toHaveLength(2);
    expect(payload.drafts[0]).toMatchObject({
      kind: expect.stringMatching(/[AB]/),
      status: 'pending',
      occurrenceCount: 1,
      occurredProjectCount: expect.any(Number),
    });
    expect(payload.drafts[0]).not.toHaveProperty('localOnly');
    expect(payload.drafts[0]).not.toHaveProperty('body');
    expect(JSON.stringify(payload)).not.toContain('example-user');
  });

  it('is readable through the tunnel (reads are outside the privileged guard; the tunnel auth covers them)', async () => {
    const { app } = setup();
    await createDraft(app);
    const res = await app.request(DRAFTS, { headers: { ...CF_HEADERS } }, TUNNEL_ENV);
    expect(res.status).toBe(200);
  });

  it('gets one draft with its hand-only context and images', async () => {
    const { app } = setup();
    const { id } = await createDraft(app);
    await app.request(`${DRAFTS}/${id}/images`, json({ mimeType: 'image/png', data: PNG_BASE64 }), LOCAL_ENV);

    const res = await app.request(`${DRAFTS}/${id}`, localGet(), LOCAL_ENV);
    expect(res.status).toBe(200);
    const payload = (await res.json()) as {
      draft: { id: string; localOnly: { errorTextRaw: string }; body: string };
      images: Array<{ fileName: string; url: string; byteLength: number }>;
    };
    expect(payload.draft.id).toBe(id);
    expect(payload.draft.localOnly.errorTextRaw).toBe('jq: command not found');
    expect(payload.images).toHaveLength(1);
    expect(payload.images[0].url).toBe(`${DRAFTS}/${id}/images/${payload.images[0].fileName}`);
    expect(payload.images[0].byteLength).toBe(PNG_BYTES.length);
  });

  it('404s an unknown id and 400s a malformed one', async () => {
    const { app } = setup();
    expect((await app.request(`${DRAFTS}/1758812345678-ffffffffffffffff`, localGet(), LOCAL_ENV)).status).toBe(404);
    expect((await app.request(`${DRAFTS}/not-an-id`, localGet(), LOCAL_ENV)).status).toBe(400);
  });
});

describe('PATCH /api/issue-reports/drafts/:id/dismiss', () => {
  it('dismisses a pending draft with a one-line reason', async () => {
    const { app, storage } = setup();
    const { id } = await createDraft(app);
    const res = await app.request(`${DRAFTS}/${id}/dismiss`, patchJson({ reason: '  not a bdboard problem  ' }), LOCAL_ENV);
    expect(res.status).toBe(200);
    const payload = (await res.json()) as { draft: { status: string; dismissReason: string } };
    expect(payload.draft).toMatchObject({ status: 'dismissed', dismissReason: 'not a bdboard problem' });
    expect(storage.drafts.get(id)?.status).toBe('dismissed');
  });

  it('then counts repeats without reopening it', async () => {
    const { app } = setup();
    const { id } = await createDraft(app);
    await app.request(`${DRAFTS}/${id}/dismiss`, patchJson({ reason: 'noise' }), LOCAL_ENV);
    const repeat = await app.request(DRAFTS, json(DRAFT_BODY), LOCAL_ENV);
    const payload = (await repeat.json()) as { draft: { status: string; occurrenceCount: number } };
    expect(payload.draft).toMatchObject({ status: 'dismissed', occurrenceCount: 2 });
  });

  it('400s a missing, blank or over-long reason, 404s unknown ids, 409s a draft that is not pending', async () => {
    const { app } = setup();
    const { id } = await createDraft(app);
    expect((await app.request(`${DRAFTS}/${id}/dismiss`, patchJson({}), LOCAL_ENV)).status).toBe(400);
    expect((await app.request(`${DRAFTS}/${id}/dismiss`, patchJson({ reason: '   ' }), LOCAL_ENV)).status).toBe(400);
    expect(
      (await app.request(`${DRAFTS}/${id}/dismiss`, patchJson({ reason: 'x'.repeat(201) }), LOCAL_ENV)).status,
    ).toBe(400);
    expect(
      (await app.request(`${DRAFTS}/1758812345678-ffffffffffffffff/dismiss`, patchJson({ reason: 'x' }), LOCAL_ENV)).status,
    ).toBe(404);
    expect((await app.request(`${DRAFTS}/not-an-id/dismiss`, patchJson({ reason: 'x' }), LOCAL_ENV)).status).toBe(400);

    expect((await app.request(`${DRAFTS}/${id}/dismiss`, patchJson({ reason: 'first' }), LOCAL_ENV)).status).toBe(200);
    expect((await app.request(`${DRAFTS}/${id}/dismiss`, patchJson({ reason: 'second' }), LOCAL_ENV)).status).toBe(409);
  });

  it('follows the ordinary write-guard: a tunnel is refused by default, allowed with a strong-password session', async () => {
    const closed = setup();
    const { id: closedId } = await createDraft(closed.app);
    const refused = await closed.app.request(
      `${DRAFTS}/${closedId}/dismiss`,
      patchJson({ reason: 'x' }, CF_HEADERS),
      TUNNEL_ENV,
    );
    expect(refused.status).toBe(403);
    expect(closed.storage.drafts.get(closedId)?.status).toBe('pending');

    const open = setup(TUNNEL_WRITE_ALLOWED);
    const { id: openId } = await createDraft(open.app);
    const allowed = await open.app.request(
      `${DRAFTS}/${openId}/dismiss`,
      patchJson({ reason: 'x' }, CF_HEADERS),
      TUNNEL_ENV,
    );
    expect(allowed.status).toBe(200);
  });
});

describe('draft images', () => {
  it('attaches an image after the same checks as ticket attachments (magic bytes, mime type)', async () => {
    const { app, storage } = setup();
    const { id } = await createDraft(app);

    const ok = await app.request(`${DRAFTS}/${id}/images`, json({ mimeType: 'image/png', data: PNG_BASE64 }), LOCAL_ENV);
    expect(ok.status).toBe(201);
    const { image } = (await ok.json()) as { image: { fileName: string; url: string } };
    expect(image.url).toBe(`${DRAFTS}/${id}/images/${image.fileName}`);

    const wrongMagic = await app.request(
      `${DRAFTS}/${id}/images`,
      json({ mimeType: 'image/png', data: Buffer.from('not a png at all').toString('base64') }),
      LOCAL_ENV,
    );
    expect(wrongMagic.status).toBe(400);
    const jpegDeclaredAsPng = await app.request(
      `${DRAFTS}/${id}/images`,
      json({ mimeType: 'image/jpeg', data: PNG_BASE64 }),
      LOCAL_ENV,
    );
    expect(jpegDeclaredAsPng.status).toBe(400);
    const unsupported = await app.request(
      `${DRAFTS}/${id}/images`,
      json({ mimeType: 'image/svg+xml', data: PNG_BASE64 }),
      LOCAL_ENV,
    );
    expect(unsupported.status).toBe(400);
    const notBase64 = await app.request(
      `${DRAFTS}/${id}/images`,
      json({ mimeType: 'image/png', data: '***not base64***' }),
      LOCAL_ENV,
    );
    expect(notBase64.status).toBe(400);
    expect(await storage.countImages(id)).toBe(1);
  });

  it('rejects an image over 10 MB (decoded) with 400 and a request body over the cap with 413', async () => {
    const { app, storage } = setup();
    const { id } = await createDraft(app);
    const big = Buffer.alloc(10 * 1024 * 1024 + 1);
    PNG_BYTES.forEach((byte, index) => { big[index] = byte; });
    const tooBig = await app.request(
      `${DRAFTS}/${id}/images`,
      json({ mimeType: 'image/png', data: big.toString('base64') }),
      LOCAL_ENV,
    );
    expect(tooBig.status).toBe(400);

    const hugeBody = await app.request(
      `${DRAFTS}/${id}/images`,
      json({}, { 'content-length': String(14 * 1024 * 1024 + 1) }),
      LOCAL_ENV,
    );
    expect(hugeBody.status).toBe(413);
    expect(await storage.countImages(id)).toBe(0);
  });

  it('404s an unknown draft and 409s past the per-draft limit', async () => {
    const { app } = setup();
    const missing = await app.request(
      `${DRAFTS}/1758812345678-ffffffffffffffff/images`,
      json({ mimeType: 'image/png', data: PNG_BASE64 }),
      LOCAL_ENV,
    );
    expect(missing.status).toBe(404);

    const { id } = await createDraft(app);
    for (let index = 0; index < ISSUE_DRAFT_MAX_IMAGES; index += 1) {
      const res = await app.request(`${DRAFTS}/${id}/images`, json({ mimeType: 'image/png', data: PNG_BASE64 }), LOCAL_ENV);
      expect(res.status).toBe(201);
    }
    const over = await app.request(`${DRAFTS}/${id}/images`, json({ mimeType: 'image/png', data: PNG_BASE64 }), LOCAL_ENV);
    expect(over.status).toBe(409);
  });

  it('keeps the draft image limit equal to the attachment image limit', () => {
    expect(ISSUE_DRAFT_MAX_IMAGES).toBe(ATTACHMENT_MAX_COUNT_PER_TICKET);
  });

  it('serves a stored image with a content type derived from its extension, and 400/404s bad requests', async () => {
    const { app } = setup();
    const { id } = await createDraft(app);
    const upload = await app.request(`${DRAFTS}/${id}/images`, json({ mimeType: 'image/png', data: PNG_BASE64 }), LOCAL_ENV);
    const { image } = (await upload.json()) as { image: { fileName: string } };

    const res = await app.request(`${DRAFTS}/${id}/images/${image.fileName}`, localGet(), LOCAL_ENV);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(Buffer.from(await res.arrayBuffer())).toEqual(Buffer.from(PNG_BYTES));

    expect((await app.request(`${DRAFTS}/${id}/images/evil.html`, localGet(), LOCAL_ENV)).status).toBe(400);
    expect((await app.request(`${DRAFTS}/${id}/images/1-aaaaaaaaaaaaaaaa.png`, localGet(), LOCAL_ENV)).status).toBe(404);
    expect((await app.request(`${DRAFTS}/not-an-id/images/${image.fileName}`, localGet(), LOCAL_ENV)).status).toBe(400);
  });
});
