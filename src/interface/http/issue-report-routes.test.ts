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

describe('POST /api/issue-reports/drafts — fields that reach the public title and body', () => {
  // 題名・本文にそのまま入る欄。行を足して見出しやパスを紛れ込ませる値は 400。
  const HOSTILE = 'stop-ticket-gate.sh\n## injected\n/Users/example-user/example-project/secret.sh';

  it.each([
    ['source', { kind: 'B', source: HOSTILE }],
    ['catalogSlug', { kind: 'A', catalogSlug: HOSTILE }],
    ['envInfo.bdboardVersion', { kind: 'B', source: 's', envInfo: { bdboardVersion: `0.1.2${'\n'}## injected` } }],
    ['envInfo.harnessVersion', { kind: 'B', source: 's', envInfo: { harnessVersion: `0.56.0${'\n'}## injected` } }],
    ['envInfo.os', { kind: 'B', source: 's', envInfo: { os: 'darwin\r\n- [x] injected' } }],
    ['envInfo.nodeVersion', { kind: 'B', source: 's', envInfo: { nodeVersion: 'v22\u2028## injected' } }],
    ['envInfo.bdVersion', { kind: 'B', source: 's', envInfo: { bdVersion: 'bd\u0000' } }],
    ['envInfo.ghVersion', { kind: 'B', source: 's', envInfo: { ghVersion: 'gh\ttab' } }],
    ['source with a trailing newline', { kind: 'B', source: 'stop-ticket-gate.sh\n' }],
  ])('400s a newline or control character in %s and stores nothing', async (_label, body) => {
    const { app, storage } = setup();
    const res = await app.request(DRAFTS, json(body), LOCAL_ENV);
    expect(res.status).toBe(400);
    expect(storage.drafts.size).toBe(0);
  });

  it('keeps a one-line source such as an API path, and puts it into one title line only', async () => {
    const { app, storage } = setup();
    const res = await app.request(DRAFTS, json({ kind: 'C', source: 'GET /api/x', errorText: 'boom' }), LOCAL_ENV);
    expect(res.status).toBe(201);
    const [draft] = [...storage.drafts.values()];
    expect(draft.source).toBe('GET /api/x');
    expect(draft.title).toBe('[bdboard 本体] GET /api/x');
    expect(draft.title).not.toContain('\n');
    // 本文の行は固定の項目だけ (見出しの "#" で始まる行は無い)。
    expect(draft.body.split('\n').filter((line) => line.startsWith('#'))).toEqual([]);
  });

  it('still 400s an empty or too-long source / catalogSlug', async () => {
    const { app } = setup();
    expect((await app.request(DRAFTS, json({ kind: 'B', source: '' }), LOCAL_ENV)).status).toBe(400);
    expect((await app.request(DRAFTS, json({ kind: 'B', source: 'x'.repeat(201) }), LOCAL_ENV)).status).toBe(400);
    expect((await app.request(DRAFTS, json({ kind: 'A', catalogSlug: 'x'.repeat(201) }), LOCAL_ENV)).status).toBe(400);
  });
});

describe('request body limits (pinned to the literal byte counts)', () => {
  /** JSON の本文がちょうど totalBytes バイトになるよう、errorText を ASCII で埋める。 */
  function receiveBodyOfBytes(totalBytes: number): string {
    const prefix = '{"kind":"C","source":"s","errorText":"';
    const suffix = '"}';
    return prefix + 'x'.repeat(totalBytes - prefix.length - suffix.length) + suffix;
  }
  const post = (body: string): RequestInit => ({
    method: 'POST',
    headers: { 'content-type': 'application/json', host: LOCAL_HOST },
    body,
  });

  it('the receive POST accepts 1048576 bytes (1 MiB) and refuses 1048577 with 413', async () => {
    const { app, storage } = setup();
    const atLimit = receiveBodyOfBytes(1_048_576);
    expect(Buffer.byteLength(atLimit)).toBe(1_048_576);
    expect((await app.request(DRAFTS, post(atLimit), LOCAL_ENV)).status).toBe(201);
    expect(storage.drafts.size).toBe(1);

    const overLimit = receiveBodyOfBytes(1_048_577);
    expect(Buffer.byteLength(overLimit)).toBe(1_048_577);
    expect((await app.request(DRAFTS, post(overLimit), LOCAL_ENV)).status).toBe(413);
  });

  it('the dismiss PATCH accepts 16384 bytes (16 KiB) past the limiter and refuses 16385 with 413', async () => {
    const { app } = setup();
    const { id } = await createDraft(app);
    const bodyOfBytes = (totalBytes: number): string => {
      const prefix = '{"reason":"';
      const suffix = '"}';
      return prefix + 'x'.repeat(totalBytes - prefix.length - suffix.length) + suffix;
    };
    const patch = (body: string): RequestInit => ({ ...post(body), method: 'PATCH' });

    // 上限ちょうどは本文の制限を通る (理由が 200 字を超えるので、中身の検査で 400)。
    const atLimit = bodyOfBytes(16_384);
    expect(Buffer.byteLength(atLimit)).toBe(16_384);
    expect((await app.request(`${DRAFTS}/${id}/dismiss`, patch(atLimit), LOCAL_ENV)).status).toBe(400);

    const overLimit = bodyOfBytes(16_385);
    expect(Buffer.byteLength(overLimit)).toBe(16_385);
    expect((await app.request(`${DRAFTS}/${id}/dismiss`, patch(overLimit), LOCAL_ENV)).status).toBe(413);
  });

  it('exports the receive cap as 1 MiB too', () => {
    expect(ISSUE_REPORT_BODY_MAX_BYTES).toBe(1_048_576);
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

  it('applies to the image upload as well, even when write-guard would let that tunnel session write', async () => {
    // 書き込み許可つきの setup にする。許可なしだと汎用の write-guard がどのみち 403 を返すので、
    // 画像 POST から localOnlyGuard を外してもこのテストが通ってしまう。
    const { app, storage } = setup(TUNNEL_WRITE_ALLOWED);
    const { id } = await createDraft(app);
    const res = await app.request(
      `${DRAFTS}/${id}/images`,
      json({ mimeType: 'image/png', data: PNG_BASE64 }, CF_HEADERS),
      TUNNEL_ENV,
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'local access only' });
    expect(await storage.countImages(id)).toBe(0);

    // 同じ設定で、ローカル直アクセスの画像は通る (許可つきの setup 自体が画像を止めていない)。
    const local = await app.request(
      `${DRAFTS}/${id}/images`,
      json({ mimeType: 'image/png', data: PNG_BASE64 }),
      LOCAL_ENV,
    );
    expect(local.status).toBe(201);
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

  // 手元限定の中身に入れておく値。トンネル側の応答には現れてはいけない。
  const TOKEN_LIKE = 'example-canary-' + 'token-0123456789abcdef';
  const SECRET_BODY = {
    kind: 'B',
    source: 'stop-ticket-gate.sh',
    symptom: `symptom mentions ${TOKEN_LIKE}-symptom`,
    cause: `cause mentions ${TOKEN_LIKE}-cause`,
    prevention: `prevention mentions ${TOKEN_LIKE}-prevention`,
    agentNote: `note mentions ${TOKEN_LIKE}-note`,
    // 短いエラー文: 表示用の先頭 (errorTextHead) は生ログそのものになる。
    errorText: `curl failed: Authorization: Bearer ${TOKEN_LIKE} at /Users/example-user/example-project/run.sh`,
    envInfo: { bdboardVersion: '0.1.2', os: 'darwin', nodeVersion: 'v22.14.0' },
    project: { name: 'example-project', path: '/Users/example-user/example-project' },
  };

  type DetailPayload = {
    draft: {
      id: string;
      restricted?: boolean;
      title: string;
      body: string;
      occurrenceCount: number;
      localOnly: Record<string, unknown>;
      occurredProjects: Array<Record<string, unknown>>;
    };
    images: Array<{ fileName: string; url: string; byteLength: number }>;
  };

  it('gets one draft with its hand-only context and images (local direct access: the full draft)', async () => {
    const { app } = setup();
    const { id } = await createDraft(app, SECRET_BODY);
    await app.request(`${DRAFTS}/${id}/images`, json({ mimeType: 'image/png', data: PNG_BASE64 }), LOCAL_ENV);

    const res = await app.request(`${DRAFTS}/${id}`, localGet(), LOCAL_ENV);
    expect(res.status).toBe(200);
    const payload = (await res.json()) as DetailPayload;
    expect(payload.draft.id).toBe(id);
    expect(payload.draft.restricted).toBe(false);
    expect(payload.draft.localOnly).toMatchObject({
      errorTextRaw: SECRET_BODY.errorText,
      errorTextHead: SECRET_BODY.errorText,
      symptomRaw: SECRET_BODY.symptom,
      causeRaw: SECRET_BODY.cause,
      preventionRaw: SECRET_BODY.prevention,
      agentNoteRaw: SECRET_BODY.agentNote,
    });
    expect(payload.draft.occurredProjects).toEqual([
      expect.objectContaining({ name: 'example-project', path: '/Users/example-user/example-project' }),
    ]);
    expect(payload.images).toHaveLength(1);
    expect(payload.images[0].url).toBe(`${DRAFTS}/${id}/images/${payload.images[0].fileName}`);
    expect(payload.images[0].byteLength).toBe(PNG_BYTES.length);
  });

  it.each([
    ['a cf-ray header (cloudflared forwards from 127.0.0.1)', { headers: { ...CF_HEADERS } }, TUNNEL_ENV],
    ['a cf-connecting-ip header on a loopback Host', localGet({ 'cf-connecting-ip': '203.0.113.9' }), LOCAL_ENV],
    ['a non-loopback TCP source', localGet(), REMOTE_ENV],
    ['a Host header that is not loopback (DNS rebinding)', localGet({ host: 'attacker.example:8787' }), LOCAL_ENV],
    ['no socket information at all', localGet(), {}],
  ])('through %s: a restricted view with no raw log, free text or absolute path', async (_label, init, env) => {
    const { app } = setup();
    const { id } = await createDraft(app, SECRET_BODY);

    const res = await app.request(`${DRAFTS}/${id}`, init, env);
    expect(res.status).toBe(200);
    const text = await res.text();
    const payload = JSON.parse(text) as DetailPayload;

    expect(payload.draft.restricted).toBe(true);
    // トークン・絶対パス・ユーザー名は、どの欄にも現れない。
    expect(text).not.toContain(TOKEN_LIKE);
    expect(text).not.toContain('Bearer');
    expect(text).not.toContain('/Users/');
    expect(text).not.toContain('example-user');
    // 生ログ・先頭と末尾・自由記述の生の文の欄そのものが無い。
    for (const key of [
      'errorTextRaw', 'errorTextHead', 'errorTextTail', 'symptomRaw', 'causeRaw', 'preventionRaw', 'agentNoteRaw',
    ]) {
      expect(payload.draft.localOnly).not.toHaveProperty(key);
    }
    expect(payload.draft.occurredProjects).toEqual([
      { name: 'example-project', firstSeenAt: expect.any(String), lastSeenAt: expect.any(String) },
    ]);
    // 表示に要る項目は残る: 題名・本文・回数・版。
    expect(payload.draft.title).toContain('stop-ticket-gate.sh');
    expect(payload.draft.body).toContain('stop-ticket-gate.sh');
    expect(payload.draft.occurrenceCount).toBe(1);
    expect(payload.draft.localOnly).toMatchObject({
      errorTextTruncated: false,
      envInfo: { bdboardVersion: '0.1.2' },
    });
  });

  it('keeps the restricted view for a very long error text too (head and tail are cuts of the raw log)', async () => {
    const { app } = setup();
    const { id } = await createDraft(app, {
      ...SECRET_BODY,
      errorText: `${TOKEN_LIKE}-head ${'m'.repeat(5000)} ${TOKEN_LIKE}-tail`,
    });
    const res = await app.request(`${DRAFTS}/${id}`, { headers: { ...CF_HEADERS } }, TUNNEL_ENV);
    const text = await res.text();
    expect(text).not.toContain(TOKEN_LIKE);
    expect((JSON.parse(text) as DetailPayload).draft.localOnly.errorTextTruncated).toBe(true);
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

  it('400s a reason that is not one line (newline, carriage return, other control characters)', async () => {
    const { app, storage } = setup();
    const { id } = await createDraft(app);
    for (const reason of ['first\nsecond', 'first\r\nsecond', 'first\rsecond', 'tab\tseparated', 'nul\u0000', 'ls\u2028ps', 'trailing\n']) {
      const res = await app.request(`${DRAFTS}/${id}/dismiss`, patchJson({ reason }), LOCAL_ENV);
      expect(res.status).toBe(400);
    }
    expect(storage.drafts.get(id)?.status).toBe('pending');
    expect(storage.drafts.get(id)?.dismissReason).toBeUndefined();
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
