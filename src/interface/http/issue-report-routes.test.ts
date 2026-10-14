import { describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import { createIssueDraftService, type IssueDraftService } from '../../application/issue-report/issue-draft-service.js';
import {
  createInMemoryIssueDraftStorage,
  type InMemoryIssueDraftStorage,
} from '../../application/issue-report/issue-draft-test-support.js';
import { ISSUE_DRAFT_MAX_IMAGES, type IssueDraft } from '../../domain/issue-draft.js';
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
    // 見えない文字: 画面の並びを入れ替える (右から左への上書き)・ゼロ幅・BOM。
    ['source with a right-to-left override', { kind: 'B', source: 'safe\u202Egnp.sh' }],
    ['source with a bidi isolate', { kind: 'B', source: 'safe\u2066hidden' }],
    ['catalogSlug with a zero-width space', { kind: 'A', catalogSlug: 'slug\u200Bname' }],
    ['source with a byte order mark', { kind: 'B', source: '\uFEFFstop-ticket-gate.sh' }],
    ['source with a word joiner', { kind: 'B', source: 'safe\u2060name.sh' }],
    ['source with an Arabic letter mark', { kind: 'B', source: 'safe\u061Cname.sh' }],
    ['source with a soft hyphen', { kind: 'B', source: 'stop-\u00ADgate.sh' }],
    ['source with a Mongolian vowel separator', { kind: 'B', source: 'safe\u180Ename.sh' }],
    ['source with a Hangul filler', { kind: 'B', source: 'safe\u3164name.sh' }],
    ['source with a tag character', { kind: 'B', source: 'safe\u{E0061}name.sh' }],
    ['catalogSlug with an interlinear annotation mark', { kind: 'A', catalogSlug: 'slug\uFFF9name' }],
    ['envInfo.os with an invisible operator', { kind: 'B', source: 's', envInfo: { os: 'darwin\u2062' } }],
    ['envInfo.bdVersion with a zero-width joiner (identifiers get no exception)', { kind: 'B', source: 's', envInfo: { bdVersion: '1\u200D0' } }],
  ])('400s a newline, control or invisible character in %s and stores nothing', async (_label, body) => {
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

  it.each([
    ['an option-shaped ref (--db=/tmp/evil)', '--db=/tmp/evil'],
    ['a ref that starts with a dash', '-x'],
    ['a path', '../../etc/passwd'],
    ['a ref with a space', 'bdboard abc'],
    ['a ref with a newline', 'bdboard-abc\n--db=/tmp/evil'],
    ['a ref with a trailing newline', 'bdboard-abc\n'],
    ['a ref that starts with a dot', '.hidden'],
    ['an empty ref', ''],
    ['a ref over 200 characters', 'a'.repeat(201)],
  ])('400s a sourceTicketRef that is %s and stores nothing', async (_label, ref) => {
    const { app, storage } = setup();
    const res = await app.request(DRAFTS, json({ ...DRAFT_BODY, sourceTicketRef: ref }), LOCAL_ENV);
    expect(res.status).toBe(400);
    expect(storage.drafts.size).toBe(0);
  });

  it.each(['bdboard-4y8q.1', 'bdboard-abc', 'a', `a${'b'.repeat(199)}`, 'proj_x.1-2'])(
    'accepts the ticket-id-shaped sourceTicketRef %s and returns it as given',
    async (ref) => {
      const { app, storage } = setup();
      const res = await app.request(DRAFTS, json({ ...DRAFT_BODY, sourceTicketRef: ref }), LOCAL_ENV);
      expect(res.status).toBe(201);
      expect(((await res.json()) as { draft: { sourceTicketRef: string } }).draft.sourceTicketRef).toBe(ref);
      expect([...storage.drafts.values()][0].sourceTicketRef).toBe(ref);
    },
  );

  // zod の既定の文言は入力の値をそのまま含む (z.enum の invalid_enum_value は "received '<値>'")。400 の本文に
  // 理由 (details) を載せると、書き込んだ側とログへ値が戻る (受け取りはローカル直アクセスのみ。トンネルの話ではない)。
  // だから固定の文言だけを返す。
  it.each([
    ['a bad kind that looks like a path', { kind: '/Users/example-user/secret-token-abc123' }],
    ['a bad kind', { kind: 'secret-token-abc123' }],
    ['a source with an invisible character', { kind: 'B', source: 'secret-token-abc123-\u200Bvalue.sh' }],
    ['a bad source type', { kind: 'B', source: { secret: 'secret-token-abc123' } }],
    ['a bad sourceTicketRef', { kind: 'B', source: 's', sourceTicketRef: '/Users/example-user/secret-token-abc123' }],
    ['a project name that is empty once cleaned', { kind: 'B', source: 's', project: { name: '\u200B', path: '/p' } }],
    ['an envInfo string with a newline', { kind: 'B', source: 's', envInfo: { os: 'secret-token-abc123\nx' } }],
  ])('400s %s with the fixed message only: no details, and never the submitted value', async (_label, body) => {
    const { app, storage } = setup();
    const res = await app.request(DRAFTS, json(body), LOCAL_ENV);
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: 'invalid request body' });
    expect(text).not.toContain('secret-token');
    expect(text).not.toContain('example-user');
    expect(storage.drafts.size).toBe(0);
  });

  it('still 400s an empty or too-long source / catalogSlug', async () => {
    const { app } = setup();
    expect((await app.request(DRAFTS, json({ kind: 'B', source: '' }), LOCAL_ENV)).status).toBe(400);
    expect((await app.request(DRAFTS, json({ kind: 'B', source: 'x'.repeat(201) }), LOCAL_ENV)).status).toBe(400);
    expect((await app.request(DRAFTS, json({ kind: 'A', catalogSlug: 'x'.repeat(201) }), LOCAL_ENV)).status).toBe(400);
  });
});

describe('POST /api/issue-reports/drafts — project.name is a display field (cleaned, home paths folded)', () => {
  const withProject = (name: string) => ({ kind: 'B', source: 's.sh', errorText: 'boom', project: { name, path: '/p/x' } });

  it('accepts an emoji sequence in the name (no 400) and stores it without the invisible joiner', async () => {
    const { app, storage } = setup();
    const res = await app.request(DRAFTS, json(withProject('\u{1F469}\u200D\u{1F4BB}-tools')), LOCAL_ENV);
    expect(res.status).toBe(201);
    expect([...storage.drafts.values()][0].occurredProjects[0].name).toBe('\u{1F469}\u{1F4BB}-tools');
  });

  it.each([
    ['a newline (a space, so the words stay apart)', 'proj\n## injected', 'proj ## injected'],
    ['a carriage return and a line separator', 'a\r\nb\u2028c', 'a b c'],
    ['a bidi override', 'proj\u202Eevil', 'projevil'],
    ['a BOM and a zero-width space', '\uFEFFproj\u200B', 'proj'],
    ['a Hangul filler (it shows as a blank, so it becomes a space)', 'pro\u{3164}j', 'pro j'],
    ['a zero-width joiner and a zero-width space stay stripped, not spaced', 'pro\u{200D}\u{200B}j', 'proj'],
    ['surrounding spaces', '  proj  ', 'proj'],
    // パスの手前の区切りになる文字は、取り除かず空白にしてから畳む: つなげると前の語にパスが貼り付いて畳めない
    ['a tab before a home path', 'proj\t/Users/example-user/proj', 'proj ~/proj'],
    ['a newline before a home path', 'proj\n/Users/example-user/proj', 'proj ~/proj'],
    ['a BOM before a home path', 'proj\uFEFF/Users/example-user/proj', 'proj ~/proj'],
    ['a line separator before a Windows home path', 'proj\u2028C:\\Users\\example-user\\proj', 'proj ~/proj'],
    ['a tab and a zero-width space inside the path word', 'proj\t/Us\u200Bers/example-user/proj', 'proj ~/proj'],
    // 画面では空白に見える文字は空白に替えてから畳む (bdboard-4lea): 取り除くと前の語にパスが貼り付き、ユーザー名が残った
    ['a Hangul filler before a home path', 'proj\u{3164}/Users/example-user/proj', 'proj ~/proj'],
    ['a Hangul choseong filler before a home path', 'proj\u{115F}/Users/example-user/proj', 'proj ~/proj'],
    ['a Hangul jungseong filler before a home path', 'proj\u{1160}/Users/example-user/proj', 'proj ~/proj'],
    ['a halfwidth Hangul filler before a home path', 'proj\u{FFA0}/Users/example-user/proj', 'proj ~/proj'],
    ['a Mongolian vowel separator before a home path', 'proj\u{180E}/Users/example-user/proj', 'proj ~/proj'],
    ['a Hangul filler before a Windows home path', 'proj\u{3164}C:\\Users\\example-user\\proj', 'proj ~/proj'],
  ])('strips %s from the name instead of rejecting it', async (_label, name, expected) => {
    const { app, storage } = setup();
    const res = await app.request(DRAFTS, json(withProject(name)), LOCAL_ENV);
    expect(res.status).toBe(201);
    const stored = [...storage.drafts.values()][0].occurredProjects[0].name;
    expect(stored).toBe(expected);
    expect(stored).not.toContain('\n');
    expect(stored).not.toContain('example-user');
  });

  it.each([
    ['empty', ''],
    ['only spaces', '   '],
    ['only invisible characters', '\u200B\uFEFF\u202E'],
    ['only newlines', '\n\r\n'],
  ])('400s a name that is %s once cleaned, and stores nothing', async (_label, name) => {
    const { app, storage } = setup();
    const res = await app.request(DRAFTS, json(withProject(name)), LOCAL_ENV);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid request body' });
    expect(storage.drafts.size).toBe(0);
  });

  it('shows a home path used as the name as ~/proj to a tunnel reader (stored folded, not just on the way out)', async () => {
    const { app, storage } = setup();
    const { id } = await createDraft(app, withProject('/Users/example-user/proj'));
    expect([...storage.drafts.values()][0].occurredProjects[0].name).toBe('~/proj');

    const detail = await (await app.request(`${DRAFTS}/${id}`, { headers: { ...CF_HEADERS } }, TUNNEL_ENV)).text();
    const payload = JSON.parse(detail) as { draft: { occurredProjects: Array<{ name: string }> } };
    expect(payload.draft.occurredProjects.map((entry) => entry.name)).toEqual(['~/proj']);
    expect(detail).not.toContain('example-user');
  });

  it('shows a home path glued behind a Hangul filler as ~/proj to a tunnel reader (bdboard-4lea)', async () => {
    const { app, storage } = setup();
    const { id } = await createDraft(app, withProject('proj\u{3164}/Users/example-user/proj'));
    expect([...storage.drafts.values()][0].occurredProjects[0].name).toBe('proj ~/proj');

    const detail = await (await app.request(`${DRAFTS}/${id}`, { headers: { ...CF_HEADERS } }, TUNNEL_ENV)).text();
    const payload = JSON.parse(detail) as { draft: { occurredProjects: Array<{ name: string }> } };
    expect(payload.draft.occurredProjects.map((entry) => entry.name)).toEqual(['proj ~/proj']);
    expect(detail).not.toContain('example-user');
  });

  it('folds a home path inside an envInfo string too', async () => {
    const { app, storage } = setup();
    const body = {
      kind: 'B',
      source: 's.sh',
      envInfo: { bdboardVersion: '0.1.2', os: 'darwin', nodeVersion: 'v22.14.0', bdVersion: 'bd 1.0 (/Users/example-user/bin/bd)' },
    };
    const { id } = await createDraft(app, body);
    expect([...storage.drafts.values()][0].localOnly.envInfo.bdVersion).toBe('bd 1.0 (~/bin/bd)');
    const detail = await (await app.request(`${DRAFTS}/${id}`, { headers: { ...CF_HEADERS } }, TUNNEL_ENV)).text();
    expect(detail).toContain('bd 1.0 (~/bin/bd)');
    expect(detail).not.toContain('example-user');
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

  describe('a source that is a path to the reporter\'s own script', () => {
    // フックが自分の "$0" を source にして報告した場合。ユーザー名は題名・本文・指紋・source のどこにも残らない。
    const HOOK = '/Users/example-user/example-project/.claude/hooks/stop-ticket-gate.sh';
    const CANONICAL = '~/example-project/.claude/hooks/stop-ticket-gate.sh';

    it('is stored as ~/…; no name, /Users/ or /home/ reaches a tunnel reader in the list, the detail or the receive response', async () => {
      const { app, storage } = setup();
      const receive = await app.request(DRAFTS, json({ ...DRAFT_BODY, source: HOOK }), LOCAL_ENV);
      expect(receive.status).toBe(201);
      const receiveText = await receive.text();
      const { id } = (JSON.parse(receiveText) as { draft: { id: string } }).draft;
      const kindAHook = await app.request(
        DRAFTS,
        json({ kind: 'A', catalogSlug: '/home/example-user/.claude/failure-catalog/jq-missing' }),
        LOCAL_ENV,
      );
      expect(kindAHook.status).toBe(201);

      const list = await (await app.request(DRAFTS, { headers: { ...CF_HEADERS } }, TUNNEL_ENV)).text();
      const detail = await (await app.request(`${DRAFTS}/${id}`, { headers: { ...CF_HEADERS } }, TUNNEL_ENV)).text();
      for (const text of [receiveText, list, detail, await kindAHook.clone().text()]) {
        expect(text).not.toContain('example-user');
        expect(text).not.toContain('/Users/');
        expect(text).not.toContain('/home/');
      }
      const payload = JSON.parse(detail) as { draft: { source: string; fingerprint: string; title: string; body: string } };
      expect(payload.draft.source).toBe(CANONICAL);
      expect(payload.draft.fingerprint.startsWith(`B:${CANONICAL}:`)).toBe(true);
      expect(payload.draft.title).toContain(CANONICAL);
      expect(payload.draft.body).toContain(CANONICAL);
      expect(storage.drafts.get(id)?.source).toBe(CANONICAL);
    });

    it('merges the same hook reported from another user\'s home into one draft', async () => {
      const { app, storage } = setup();
      expect((await app.request(DRAFTS, json({ ...DRAFT_BODY, source: HOOK }), LOCAL_ENV)).status).toBe(201);
      const other = await app.request(
        DRAFTS,
        json({ ...DRAFT_BODY, source: HOOK.replace('example-user', 'example-other-user') }),
        LOCAL_ENV,
      );
      expect(other.status).toBe(200);
      expect(((await other.json()) as { outcome: string }).outcome).toBe('merged');
      expect(storage.drafts.size).toBe(1);
    });

    it('leaves an API path that merely contains /home/ or /Users/ alone', async () => {
      const { app, storage } = setup();
      for (const source of ['GET /api/home/x', 'POST /api/Users/42/profile']) {
        expect((await app.request(DRAFTS, json({ kind: 'C', source, errorText: 'boom' }), LOCAL_ENV)).status).toBe(201);
      }
      expect([...storage.drafts.values()].map((draft) => draft.source).sort()).toEqual([
        'GET /api/home/x',
        'POST /api/Users/42/profile',
      ]);
    });
  });

  describe('a draft that already holds a raw home path (written to the store directly, not through the receive API)', () => {
    // 受け取りが畳み損ねた値・古い版が書いた値・手で書き換えた値の想定。トンネルの応答の組み立てがもう一度畳む。
    const RAW_ID = '1758812345678-aaaaaaaaaaaaaaaa';
    const RAW = '/Users/example-user/example-project/.claude/hooks/stop-ticket-gate.sh';
    const FOLDED = '~/example-project/.claude/hooks/stop-ticket-gate.sh';
    const rawDraft: IssueDraft = {
      id: RAW_ID,
      kind: 'B',
      fingerprint: `B:${RAW}:0123456789abcdef`,
      source: RAW,
      catalogSlug: '/home/example-user/.claude/failure-catalog/jq-missing',
      title: `[hook] ${RAW}`,
      body: `- source: ${RAW}\n- cwd: /mnt/c/Users/example-user/proj`,
      titleEditedByUser: false,
      bodyEditedByUser: false,
      localOnly: {
        symptomRaw: 'symptom',
        causeRaw: 'cause',
        preventionRaw: 'prevention',
        errorTextRaw: 'boom',
        errorTextHead: 'boom',
        errorTextTail: '',
        errorTextTruncated: false,
        envInfo: { bdboardVersion: '0.1.2', os: 'darwin', nodeVersion: 'v22.14.0', bdVersion: '/Users/example-user/bin/bd' },
      },
      occurredProjects: [
        { name: '/Users/example-user/proj', path: '/Users/example-user/proj', firstSeenAt: '2026-10-04T12:00:00.000Z', lastSeenAt: '2026-10-04T12:00:00.000Z' },
      ],
      occurrenceCount: 1,
      firstOccurredAt: '2026-10-04T12:00:00.000Z',
      lastOccurredAt: '2026-10-04T12:00:00.000Z',
      status: 'pending',
      harnessVersionAtOccurrence: 'C:\\Users\\example-user\\harness',
      draftSchemaVersion: 1,
    };

    it('is folded to ~/… in a tunnel reader\'s list and detail, in every field that carries a name or a sentence', async () => {
      const { app, storage } = setup();
      storage.drafts.set(RAW_ID, rawDraft);

      const list = await (await app.request(DRAFTS, { headers: { ...CF_HEADERS } }, TUNNEL_ENV)).text();
      const detail = await (await app.request(`${DRAFTS}/${RAW_ID}`, { headers: { ...CF_HEADERS } }, TUNNEL_ENV)).text();
      for (const text of [list, detail]) {
        expect(text).not.toContain('example-user');
        expect(text).not.toContain('/Users/');
        expect(text).not.toContain('/home/');
      }
      const listed = (JSON.parse(list) as { drafts: Array<{ fingerprint: string; title: string }> }).drafts[0];
      expect(listed.fingerprint).toBe(`B:${FOLDED}:0123456789abcdef`);
      expect(listed.title).toBe(`[hook] ${FOLDED}`);

      const { draft } = JSON.parse(detail) as {
        draft: {
          source: string;
          catalogSlug: string;
          fingerprint: string;
          title: string;
          body: string;
          harnessVersionAtOccurrence: string;
          occurredProjects: Array<{ name: string }>;
          localOnly: { envInfo: { bdVersion: string } };
        };
      };
      expect(draft.source).toBe(FOLDED);
      expect(draft.catalogSlug).toBe('~/.claude/failure-catalog/jq-missing');
      expect(draft.fingerprint).toBe(`B:${FOLDED}:0123456789abcdef`);
      expect(draft.title).toBe(`[hook] ${FOLDED}`);
      expect(draft.body).toBe(`- source: ${FOLDED}\n- cwd: ~/proj`);
      expect(draft.occurredProjects.map((entry) => entry.name)).toEqual(['~/proj']);
      expect(draft.localOnly.envInfo.bdVersion).toBe('~/bin/bd');
      expect(draft.harnessVersionAtOccurrence).toBe('~/harness');
    });

    // 指紋の頭の印 (A: B: C: mass-occurrence:) は残して後ろを畳む。印の形に見えるドライブ文字のパスや、
    // 印の無い指紋は、最初の ":" で切らず全体を畳む。ローカルの一覧でも畳む (一覧・受け取り・見送りの応答は全員同じ)。
    it.each([
      ['a B fingerprint keeps its marker', 'B:/Users/example-user/x.sh:abcd', 'B:~/x.sh:abcd'],
      ['a C fingerprint keeps its marker', 'C:/Users/example-user/x.sh:abcd', 'C:~/x.sh:abcd'],
      ['a marker-like text later in the string is not a marker', '/Users/example-user/proj-C:abcd', '~/proj-C:abcd'],
      ['an A fingerprint keeps its marker', 'A:/Users/example-user/slug', 'A:~/slug'],
      ['a Windows path that looks like a marker is folded as a whole', 'C:\\Users\\example-user\\x:abcd', '~/x:abcd'],
      ['a fingerprint with no marker is folded as a whole', '/Users/example-user/x:abcd', '~/x:abcd'],
      ['a drive letter that is not a marker is folded as a whole', 'D:/Users/example-user/x:abcd', '~/x:abcd'],
      ['a marker followed by a Windows path', 'B:C:\\Users\\example-user\\x:abcd', 'B:~/x:abcd'],
      // 取りこぼし (docs/ISSUE-REPORTING.md の「指紋の取りこぼし」、bdboard-4lea): 畳んでいない出どころが保存先へ直接書かれた
      // 場合だけ。字面では印かドライブ文字か区別できない。
      [
        'caveat: a root-relative Windows source on a marker drive reads as a drive path and loses the marker (no user name left)',
        'B:\\Users\\example-user\\hook.ps1:abcd',
        '~/hook.ps1:abcd',
      ],
      [
        'caveat: a name with a space under a marker drive keeps the part after the space',
        'C:/Users/example user/x:abcd',
        'C:~/ user/x:abcd',
      ],
      ['a mass-occurrence fingerprint is left as it is', 'mass-occurrence:B:2026-10-04T12', 'mass-occurrence:B:2026-10-04T12'],
      ['an A fingerprint with a plain slug is left as it is', 'A:jq-missing', 'A:jq-missing'],
    ])('folds the fingerprint in the list and the tunnel detail: %s', async (_label, fingerprint, expected) => {
      const { app, storage } = setup();
      storage.drafts.set(RAW_ID, { ...rawDraft, fingerprint });
      const tunnelList = (await (await app.request(DRAFTS, { headers: { ...CF_HEADERS } }, TUNNEL_ENV)).json()) as {
        drafts: Array<{ fingerprint: string }>;
      };
      const localList = (await (await app.request(DRAFTS, localGet(), LOCAL_ENV)).json()) as {
        drafts: Array<{ fingerprint: string }>;
      };
      const tunnelDetail = (await (await app.request(`${DRAFTS}/${RAW_ID}`, { headers: { ...CF_HEADERS } }, TUNNEL_ENV)).json()) as {
        draft: { fingerprint: string };
      };
      expect(tunnelList.drafts[0].fingerprint).toBe(expected);
      expect(localList.drafts[0].fingerprint).toBe(expected);
      expect(tunnelDetail.draft.fingerprint).toBe(expected);
    });

    it('is not rewritten for the local reader (the stored value is shown as it is) and is not changed in the store', async () => {
      const { app, storage } = setup();
      storage.drafts.set(RAW_ID, rawDraft);
      const res = await app.request(`${DRAFTS}/${RAW_ID}`, localGet(), LOCAL_ENV);
      const { draft } = (await res.json()) as { draft: { source: string; restricted: boolean; occurredProjects: Array<{ path: string }> } };
      expect(draft.restricted).toBe(false);
      expect(draft.source).toBe(RAW);
      expect(draft.occurredProjects[0].path).toBe('/Users/example-user/proj');
      expect(storage.drafts.get(RAW_ID)?.source).toBe(RAW);
    });
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

  it('drops a pasted zero-width space or BOM from the reason, keeps the ZWJ / ZWNJ of emoji and Persian text', async () => {
    const { app, storage } = setup();
    const { id } = await createDraft(app);
    const reason = '\uFEFFnot a\u200B bdboard problem \u{1F469}\u200D\u{1F4BB} \u0645\u06CC\u200C\u062E\u0648\u0627\u0647\u0645';
    const res = await app.request(`${DRAFTS}/${id}/dismiss`, patchJson({ reason }), LOCAL_ENV);
    expect(res.status).toBe(200);
    expect(storage.drafts.get(id)?.dismissReason).toBe(
      'not a bdboard problem \u{1F469}\u200D\u{1F4BB} \u0645\u06CC\u200C\u062E\u0648\u0627\u0647\u0645',
    );
  });

  it('400s any other invisible or format character in the reason, and a reason that is only pasted zero-width characters', async () => {
    const { app, storage } = setup();
    const { id } = await createDraft(app);
    const hostile = [
      'a\u202Eb', 'a\u2066b', 'a\u2060b', 'a\u00ADb', 'a\u061Cb', 'a\u180Eb', 'a\u3164b', 'a\uFFF9b', 'a\u{E0061}b',
      '\u200B\uFEFF', '\u200B',
    ];
    for (const reason of hostile) {
      const res = await app.request(`${DRAFTS}/${id}/dismiss`, patchJson({ reason }), LOCAL_ENV);
      expect(res.status, JSON.stringify(reason)).toBe(400);
    }
    const detail = await app.request(`${DRAFTS}/${id}/dismiss`, patchJson({ reason: 'a\u202Eb' }), LOCAL_ENV);
    expect(await detail.json()).toEqual({ error: 'invalid request body' });
    expect(storage.drafts.get(id)?.status).toBe('pending');
  });

  it('400s a reason with nothing visible left: only joiners / non-joiners and whitespace (after dropping the pasted zero-width characters)', async () => {
    const { app, storage } = setup();
    const { id } = await createDraft(app);
    for (const reason of ['\u200D', '\u200C', '\u200C\u200D', ' \u200D ', '\u200D\u200B\u200D', '\uFEFF\u200D', '\u3000\u200D']) {
      const res = await app.request(`${DRAFTS}/${id}/dismiss`, patchJson({ reason }), LOCAL_ENV);
      expect(res.status, JSON.stringify(reason)).toBe(400);
    }
    expect(storage.drafts.get(id)?.status).toBe('pending');
    expect(storage.drafts.get(id)?.dismissReason).toBeUndefined();
    // 見える文字が一つでもあれば通る (絵文字の連結もそのまま)
    const ok = await app.request(`${DRAFTS}/${id}/dismiss`, patchJson({ reason: '\u200D\u{1F469}\u200D\u{1F4BB}' }), LOCAL_ENV);
    expect(ok.status).toBe(200);
  });

  // bdboard-4lea: 結合文字 (\p{M}) と点字の空白だけの理由は、手前に付く文字が無く何も見えないので 400。
  it('400s a reason made only of combining marks, variation selectors or the braille blank, and keeps the draft pending', async () => {
    const { app, storage } = setup();
    const { id } = await createDraft(app);
    for (const reason of [
      '\u{0301}', '\u{FE0F}', '\u{034F}', '\u{2800}', '\u{17B4}', '\u{E0100}', ' \u{FE0F}\u{200D}\u{2800} ', '\u{0301}\u{0301}',
    ]) {
      const res = await app.request(`${DRAFTS}/${id}/dismiss`, patchJson({ reason }), LOCAL_ENV);
      expect(res.status, JSON.stringify(reason)).toBe(400);
      expect(await res.json()).toEqual({ error: 'invalid request body' });
    }
    expect(storage.drafts.get(id)?.status).toBe('pending');
    expect(storage.drafts.get(id)?.dismissReason).toBeUndefined();
  });

  it('still accepts emoji sequences and accented text as a reason', async () => {
    const { app, storage } = setup();
    for (const reason of ['\u{200D}\u{1F469}\u{200D}\u{1F4BB}', 'cafe\u{0301}', 'e\u{0301}', '\u{2764}\u{FE0F}']) {
      const { id } = await createDraft(app, { ...DRAFT_BODY, source: `s-${[...reason].length}-${reason.codePointAt(0)}.sh` });
      const res = await app.request(`${DRAFTS}/${id}/dismiss`, patchJson({ reason }), LOCAL_ENV);
      expect(res.status, JSON.stringify(reason)).toBe(200);
      expect(storage.drafts.get(id)?.dismissReason).toBe(reason);
    }
  });

  it('does not echo the submitted reason in a 400', async () => {
    const { app } = setup();
    const { id } = await createDraft(app);
    for (const body of [{ reason: 'secret-token-abc123\n/Users/example-user/x' }, { reason: 42 }, { reason: { secret: 'secret-token-abc123' } }]) {
      const res = await app.request(`${DRAFTS}/${id}/dismiss`, patchJson(body), LOCAL_ENV);
      expect(res.status).toBe(400);
      const text = await res.text();
      expect(JSON.parse(text)).toEqual({ error: 'invalid request body' });
      expect(text).not.toContain('secret-token');
      expect(text).not.toContain('example-user');
    }
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
    // 機械が読む code (bdboard-8zwi): 未処理でない下書きの 409 (draft-not-pending) と見分けるため。
    expect(await over.json()).toEqual({
      error: `image limit reached (max ${ISSUE_DRAFT_MAX_IMAGES} per draft)`,
      code: 'image-limit-reached',
    });
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

  // bdboard-4y8q.3.2: スクリーンショットには生ログと同じ種類の秘密が写りうるので、トンネル経由では
  // (書き込み許可つきのセッションがあっても) 画像を返さない。ローカル直アクセスの同じリンクの読み込みは通す。
  it('serves draft images to local requests only (tunnel 403 even with a write-allowed session)', async () => {
    const { app } = setup(TUNNEL_WRITE_ALLOWED);
    const { id } = await createDraft(app);
    const upload = await app.request(`${DRAFTS}/${id}/images`, json({ mimeType: 'image/png', data: PNG_BASE64 }), LOCAL_ENV);
    const { image } = (await upload.json()) as { image: { fileName: string } };
    const url = `${DRAFTS}/${id}/images/${image.fileName}`;

    const tunnel = await app.request(url, { headers: { ...CF_HEADERS } }, TUNNEL_ENV);
    expect(tunnel.status).toBe(403);
    expect(tunnel.headers.get('content-type')).not.toBe('image/png');
    const remote = await app.request(url, { headers: { host: LOCAL_HOST } }, REMOTE_ENV);
    expect(remote.status).toBe(403);
    const sameOriginClick = await app.request(url, localGet({ 'sec-fetch-site': 'same-origin' }), LOCAL_ENV);
    expect(sameOriginClick.status).toBe(200);
  });
});
