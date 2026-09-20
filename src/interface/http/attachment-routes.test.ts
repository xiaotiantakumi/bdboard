import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { compareStrings } from '../../domain/compare.js';
import { makeTicket } from '../../domain/test-support.js';
import type { Project } from '../../domain/project.js';
import type { BoardCache, CachedProject } from '../../application/ports/board-cache.js';
import {
  createEmptyCfdCacheMethods,
  createEmptyInteractionsCacheMethods,
  createEmptySessionLinksCacheMethods,
} from '../../application/ports/board-cache-fakes.js';
import type {
  AttachmentStoragePort,
  StoredAttachment,
} from '../../application/ports/attachment-storage.js';
import { createAttachmentRoutes, toProjectAttachmentKey } from './attachment-routes.js';
import type { WriteGuardDeps } from './write-guard.js';

const LOCAL_HOST = 'localhost:8787';
const LOCAL_ENV = {
  incoming: { socket: { remoteAddress: '127.0.0.1', localPort: 8787 } },
};
function withLocalHost(init: RequestInit = {}): RequestInit {
  const headers = new Headers(init.headers);
  if (!headers.has('Host')) headers.set('Host', LOCAL_HOST);
  return { ...init, headers };
}

const NOW = new Date('2026-09-20T00:00:00.000Z');
const PNG_BYTES = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
const PNG_BASE64 = Buffer.from(PNG_BYTES).toString('base64');

function project(id: string, rootPath: string): Project {
  return {
    id,
    name: id,
    rootPath,
    prefixes: ['bdboard'],
    aliasPaths: [],
  };
}

function cachedProject(proj: Project, ticketIds: readonly string[] = ['bdboard-1']): CachedProject {
  return {
    project: proj,
    tickets: ticketIds.map((id) => makeTicket({ id, projectId: proj.id })),
    fingerprint: `fp-${proj.id}`,
    fetchedAt: NOW,
  };
}

function createFakeBoardCache(entries: readonly CachedProject[] = []): BoardCache {
  const byId = new Map(entries.map((entry) => [entry.project.id, entry]));
  return {
    getProject: (projectId: string) => byId.get(projectId),
    putProject: (entry: CachedProject) => {
      byId.set(entry.project.id, entry);
    },
    listProjects: () => [...byId.values()].sort((a, b) => compareStrings(a.project.rootPath, b.project.rootPath)),
    deleteProject: (projectId: string) => {
      byId.delete(projectId);
    },
    clear: () => byId.clear(),
    getTranscriptOffset: () => undefined,
    setTranscriptOffset: () => {},
    addSessionUsage: () => {},
    getSessionUsage: () => [],
    ...createEmptyCfdCacheMethods(),
    ...createEmptySessionLinksCacheMethods(),
    ...createEmptyInteractionsCacheMethods(),
    close: () => {},
  };
}

function createFakeAttachmentStorage(overrides: {
  readonly countOverride?: number;
} = {}): AttachmentStoragePort & { readonly files: Map<string, Buffer> } {
  const files = new Map<string, Buffer>();
  const key = (projectKey: string, issueId: string, fileName: string) =>
    `${projectKey}/${issueId}/${fileName}`;
  const byIssue = new Map<string, StoredAttachment[]>();
  let seq = 0;

  return {
    files,
    async count(projectKey, issueId) {
      if (overrides.countOverride !== undefined) return overrides.countOverride;
      return byIssue.get(`${projectKey}/${issueId}`)?.length ?? 0;
    },
    async save(projectKey, issueId, extension, data) {
      seq += 1;
      const fileName = `${1758300000000 + seq}-${seq.toString(16).padStart(16, '0')}.${extension}`;
      files.set(key(projectKey, issueId, fileName), Buffer.from(data));
      const entry: StoredAttachment = { fileName, byteLength: data.byteLength, createdAt: NOW };
      const issueKey = `${projectKey}/${issueId}`;
      byIssue.set(issueKey, [...(byIssue.get(issueKey) ?? []), entry]);
      return entry;
    },
    async list(projectKey, issueId) {
      return byIssue.get(`${projectKey}/${issueId}`) ?? [];
    },
    async read(projectKey, issueId, fileName) {
      return files.get(key(projectKey, issueId, fileName));
    },
    async delete(projectKey, issueId, fileName) {
      const fileKey = key(projectKey, issueId, fileName);
      if (!files.has(fileKey)) return false;
      files.delete(fileKey);
      const issueKey = `${projectKey}/${issueId}`;
      const remaining = (byIssue.get(issueKey) ?? []).filter((entry) => entry.fileName !== fileName);
      byIssue.set(issueKey, remaining);
      return true;
    },
  };
}

function createApp(overrides: {
  readonly cache?: BoardCache;
  readonly storage?: AttachmentStoragePort;
  readonly writeAccess?: WriteGuardDeps;
} = {}): Hono {
  return createAttachmentRoutes({
    cache: overrides.cache ?? createFakeBoardCache([cachedProject(project('p', '/tmp/p'))]),
    storage: overrides.storage ?? createFakeAttachmentStorage(),
    ...(overrides.writeAccess !== undefined ? { writeAccess: overrides.writeAccess } : {}),
  });
}

afterEach(() => {
  vi.resetAllMocks();
  vi.restoreAllMocks();
});

describe('GET /api/tickets/:id/attachments', () => {
  it('returns an empty list for a known ticket with no attachments', async () => {
    const app = createApp();
    const res = await app.request('/api/tickets/bdboard-1/attachments', {}, {});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ attachments: [] });
  });

  it('404s for an unknown ticket', async () => {
    const app = createApp();
    const res = await app.request('/api/tickets/bdboard-999/attachments', {}, {});
    expect(res.status).toBe(404);
  });

  it('400s for an unsafe ticket id', async () => {
    const app = createApp();
    const res = await app.request(`/api/tickets/${encodeURIComponent('bad id')}/attachments`, {}, {});
    expect(res.status).toBe(400);
  });

  it('lists an attachment after a successful upload, with a fetchable url', async () => {
    const storage = createFakeAttachmentStorage();
    const app = createApp({ storage });
    const upload = await app.request(
      '/api/tickets/bdboard-1/attachments',
      withLocalHost({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mimeType: 'image/png', data: PNG_BASE64 }),
      }),
      LOCAL_ENV,
    );
    expect(upload.status).toBe(201);
    const uploadBody = (await upload.json()) as { attachment: { url: string; fileName: string } };

    const list = await app.request('/api/tickets/bdboard-1/attachments', {}, {});
    const listBody = (await list.json()) as { attachments: { fileName: string; url: string }[] };
    expect(listBody.attachments).toHaveLength(1);
    expect(listBody.attachments[0]?.fileName).toBe(uploadBody.attachment.fileName);

    const image = await app.request(uploadBody.attachment.url, {}, {});
    expect(image.status).toBe(200);
    expect(image.headers.get('content-type')).toBe('image/png');
    expect(image.headers.get('x-content-type-options')).toBe('nosniff');
    expect(image.headers.get('content-disposition')).toBe('inline');
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(new Uint8Array(PNG_BYTES));
  });
});

describe('POST /api/tickets/:id/attachments', () => {
  it('rejects a request without local access or an authorized tunnel session', async () => {
    const app = createApp();
    const res = await app.request('/api/tickets/bdboard-1/attachments', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mimeType: 'image/png', data: PNG_BASE64 }),
    }, {});
    expect(res.status).toBe(403);
  });

  it('404s for an unknown ticket before touching storage', async () => {
    const app = createApp();
    const res = await app.request(
      '/api/tickets/bdboard-999/attachments',
      withLocalHost({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mimeType: 'image/png', data: PNG_BASE64 }),
      }),
      LOCAL_ENV,
    );
    expect(res.status).toBe(404);
  });

  it('rejects an unsupported mime type', async () => {
    const app = createApp();
    const res = await app.request(
      '/api/tickets/bdboard-1/attachments',
      withLocalHost({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mimeType: 'image/svg+xml', data: PNG_BASE64 }),
      }),
      LOCAL_ENV,
    );
    expect(res.status).toBe(400);
  });

  it('rejects bytes whose magic number does not match the declared mime type', async () => {
    const app = createApp();
    const jpegDisguisedAsPng = Buffer.from([0xff, 0xd8, 0xff]).toString('base64');
    const res = await app.request(
      '/api/tickets/bdboard-1/attachments',
      withLocalHost({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mimeType: 'image/png', data: jpegDisguisedAsPng }),
      }),
      LOCAL_ENV,
    );
    expect(res.status).toBe(400);
  });

  it('rejects once the per-ticket attachment limit is reached', async () => {
    const storage = createFakeAttachmentStorage({ countOverride: 20 });
    const app = createApp({ storage });
    const res = await app.request(
      '/api/tickets/bdboard-1/attachments',
      withLocalHost({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mimeType: 'image/png', data: PNG_BASE64 }),
      }),
      LOCAL_ENV,
    );
    expect(res.status).toBe(409);
  });

  it('rejects a multipart body via the shared CSRF content-type check', async () => {
    const app = createApp();
    const form = new FormData();
    form.set('file', new Blob([Buffer.from(PNG_BYTES)], { type: 'image/png' }), 'a.png');
    const res = await app.request(
      '/api/tickets/bdboard-1/attachments',
      withLocalHost({ method: 'POST', body: form }),
      LOCAL_ENV,
    );
    expect(res.status).toBe(403);
  });
});

describe('GET /api/tickets/:id/attachments/:fileName', () => {
  it('400s for a file name that is not server-generated', async () => {
    const app = createApp();
    const res = await app.request('/api/tickets/bdboard-1/attachments/photo.png', {}, {});
    expect(res.status).toBe(400);
  });

  it('400s for a disallowed extension even when the rest of the shape matches', async () => {
    const app = createApp();
    const res = await app.request(
      '/api/tickets/bdboard-1/attachments/1758300000000-0123456789abcdef.svg',
      {},
      {},
    );
    expect(res.status).toBe(400);
  });

  it('404s when the file is not on disk', async () => {
    const app = createApp();
    const res = await app.request(
      '/api/tickets/bdboard-1/attachments/1758300000000-0123456789abcdef.png',
      {},
      {},
    );
    expect(res.status).toBe(404);
  });
});

describe('POST /api/tickets/:id/attachments concurrency', () => {
  it('never stores more than the per-ticket limit under concurrent uploads (TOCTOU regression, bdboard-qw26)', async () => {
    // count() と save() の間に別リクエストが割り込めると、同時アップロードが
    // 両方とも上限チェックを通過して超過保存されてしまう (Opus レビューで
    // 実サーバーに対する30並列アップロードで再現確認済み)。この fake storage
    // は count/save の両方に明示的な await の隙間 (setImmediate) を挟むことで、
    // ロックが無ければ確実にレースが顕在化するようにしている。
    const files = new Map<string, Buffer>();
    const byIssue = new Map<string, StoredAttachment[]>();
    let seq = 0;
    const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
    const storage: AttachmentStoragePort = {
      async count(projectKey, issueId) {
        await tick();
        return byIssue.get(`${projectKey}/${issueId}`)?.length ?? 0;
      },
      async save(projectKey, issueId, extension, data) {
        await tick();
        seq += 1;
        const fileName = `${1758300000000 + seq}-${seq.toString(16).padStart(16, '0')}.${extension}`;
        files.set(`${projectKey}/${issueId}/${fileName}`, Buffer.from(data));
        const entry: StoredAttachment = { fileName, byteLength: data.byteLength, createdAt: NOW };
        const issueKey = `${projectKey}/${issueId}`;
        byIssue.set(issueKey, [...(byIssue.get(issueKey) ?? []), entry]);
        return entry;
      },
      async list(projectKey, issueId) {
        return byIssue.get(`${projectKey}/${issueId}`) ?? [];
      },
      async read(projectKey, issueId, fileName) {
        return files.get(`${projectKey}/${issueId}/${fileName}`);
      },
      async delete(projectKey, issueId, fileName) {
        const key = `${projectKey}/${issueId}/${fileName}`;
        if (!files.has(key)) return false;
        files.delete(key);
        const issueKey = `${projectKey}/${issueId}`;
        byIssue.set(
          issueKey,
          (byIssue.get(issueKey) ?? []).filter((entry) => entry.fileName !== fileName),
        );
        return true;
      },
    };
    const app = createApp({ storage });

    const ATTACHMENT_MAX_COUNT_PER_TICKET = 20;
    const attempts = 30;
    const responses = await Promise.all(
      Array.from({ length: attempts }, () =>
        app.request(
          '/api/tickets/bdboard-1/attachments',
          withLocalHost({
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ mimeType: 'image/png', data: PNG_BASE64 }),
          }),
          LOCAL_ENV,
        ),
      ),
    );

    const created = responses.filter((res) => res.status === 201);
    const limitReached = responses.filter((res) => res.status === 409);
    expect(created).toHaveLength(ATTACHMENT_MAX_COUNT_PER_TICKET);
    expect(limitReached).toHaveLength(attempts - ATTACHMENT_MAX_COUNT_PER_TICKET);

    const finalList = await storage.list(toProjectAttachmentKey('/tmp/p'), 'bdboard-1');
    expect(finalList).toHaveLength(ATTACHMENT_MAX_COUNT_PER_TICKET);
  });
});

describe('DELETE /api/tickets/:id/attachments/:fileName', () => {
  it('rejects a request without local access or an authorized tunnel session', async () => {
    const storage = createFakeAttachmentStorage();
    const app = createApp({ storage });
    const upload = await app.request(
      '/api/tickets/bdboard-1/attachments',
      withLocalHost({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mimeType: 'image/png', data: PNG_BASE64 }),
      }),
      LOCAL_ENV,
    );
    const uploadBody = (await upload.json()) as { attachment: { fileName: string } };

    const res = await app.request(
      `/api/tickets/bdboard-1/attachments/${uploadBody.attachment.fileName}`,
      { method: 'DELETE' },
      {},
    );
    expect(res.status).toBe(403);
    // Not authorized to delete, so it must still be listed.
    const list = await app.request('/api/tickets/bdboard-1/attachments', {}, {});
    expect(((await list.json()) as { attachments: unknown[] }).attachments).toHaveLength(1);
  });

  it('400s for a file name that is not server-generated', async () => {
    const app = createApp();
    const res = await app.request(
      '/api/tickets/bdboard-1/attachments/photo.png',
      withLocalHost({ method: 'DELETE' }),
      LOCAL_ENV,
    );
    expect(res.status).toBe(400);
  });

  it('400s for a disallowed extension even when the rest of the shape matches', async () => {
    const app = createApp();
    const res = await app.request(
      '/api/tickets/bdboard-1/attachments/1758300000000-0123456789abcdef.svg',
      withLocalHost({ method: 'DELETE' }),
      LOCAL_ENV,
    );
    expect(res.status).toBe(400);
  });

  it('404s for an unknown ticket before touching storage', async () => {
    const app = createApp();
    const res = await app.request(
      '/api/tickets/bdboard-999/attachments/1758300000000-0123456789abcdef.png',
      withLocalHost({ method: 'DELETE' }),
      LOCAL_ENV,
    );
    expect(res.status).toBe(404);
  });

  it('404s when the file does not exist on the known ticket', async () => {
    const app = createApp();
    const res = await app.request(
      '/api/tickets/bdboard-1/attachments/1758300000000-0123456789abcdef.png',
      withLocalHost({ method: 'DELETE' }),
      LOCAL_ENV,
    );
    expect(res.status).toBe(404);
  });

  it('deletes a stored attachment: it disappears from the list and GET 404s afterward', async () => {
    const storage = createFakeAttachmentStorage();
    const app = createApp({ storage });
    const upload = await app.request(
      '/api/tickets/bdboard-1/attachments',
      withLocalHost({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mimeType: 'image/png', data: PNG_BASE64 }),
      }),
      LOCAL_ENV,
    );
    const uploadBody = (await upload.json()) as { attachment: { fileName: string; url: string } };

    const del = await app.request(
      `/api/tickets/bdboard-1/attachments/${uploadBody.attachment.fileName}`,
      withLocalHost({ method: 'DELETE' }),
      LOCAL_ENV,
    );
    expect(del.status).toBe(200);
    expect(await del.json()).toEqual({ ok: true });

    const list = await app.request('/api/tickets/bdboard-1/attachments', {}, {});
    expect(((await list.json()) as { attachments: unknown[] }).attachments).toEqual([]);

    const get = await app.request(uploadBody.attachment.url, {}, {});
    expect(get.status).toBe(404);
  });

  it('the second of two concurrent deletes of the same file gets 404, not a crash or double-success', async () => {
    const storage = createFakeAttachmentStorage();
    const app = createApp({ storage });
    const upload = await app.request(
      '/api/tickets/bdboard-1/attachments',
      withLocalHost({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mimeType: 'image/png', data: PNG_BASE64 }),
      }),
      LOCAL_ENV,
    );
    const uploadBody = (await upload.json()) as { attachment: { fileName: string } };
    const deleteUrl = `/api/tickets/bdboard-1/attachments/${uploadBody.attachment.fileName}`;

    const [first, second] = await Promise.all([
      app.request(deleteUrl, withLocalHost({ method: 'DELETE' }), LOCAL_ENV),
      app.request(deleteUrl, withLocalHost({ method: 'DELETE' }), LOCAL_ENV),
    ]);
    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([200, 404]);
  });

  it('never lets a concurrent delete + upload exceed the per-ticket limit at capacity (bdboard-ij1h)', async () => {
    // Same regression shape as the upload-only TOCTOU test above, but this time
    // the count is exactly at the cap and one of the concurrent requests is a
    // delete for an existing file while the rest are uploads. Serializing
    // delete through the same runExclusive lock as count/save must keep the
    // final stored count within the limit.
    const files = new Map<string, Buffer>();
    const byIssue = new Map<string, StoredAttachment[]>();
    let seq = 0;
    const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
    const issueKey = `${toProjectAttachmentKey('/tmp/p')}/bdboard-1`;
    const ATTACHMENT_MAX_COUNT_PER_TICKET = 20;
    const seed: StoredAttachment[] = Array.from({ length: ATTACHMENT_MAX_COUNT_PER_TICKET }, (_, i) => ({
      fileName: `1758300000000-${(i + 1).toString(16).padStart(16, '0')}.png`,
      byteLength: 8,
      createdAt: NOW,
    }));
    byIssue.set(issueKey, seed);
    for (const entry of seed) {
      files.set(`${issueKey}/${entry.fileName}`, Buffer.from(PNG_BYTES));
    }
    const storage: AttachmentStoragePort = {
      async count(projectKey, issueId) {
        await tick();
        return byIssue.get(`${projectKey}/${issueId}`)?.length ?? 0;
      },
      async save(projectKey, issueId, extension, data) {
        await tick();
        seq += 1;
        const fileName = `${1758300000000 + 1000 + seq}-${seq.toString(16).padStart(16, '0')}.${extension}`;
        files.set(`${projectKey}/${issueId}/${fileName}`, Buffer.from(data));
        const entry: StoredAttachment = { fileName, byteLength: data.byteLength, createdAt: NOW };
        const key = `${projectKey}/${issueId}`;
        byIssue.set(key, [...(byIssue.get(key) ?? []), entry]);
        return entry;
      },
      async list(projectKey, issueId) {
        return byIssue.get(`${projectKey}/${issueId}`) ?? [];
      },
      async read(projectKey, issueId, fileName) {
        return files.get(`${projectKey}/${issueId}/${fileName}`);
      },
      async delete(projectKey, issueId, fileName) {
        await tick();
        const key = `${projectKey}/${issueId}/${fileName}`;
        if (!files.has(key)) return false;
        files.delete(key);
        const issueKeyLocal = `${projectKey}/${issueId}`;
        byIssue.set(
          issueKeyLocal,
          (byIssue.get(issueKeyLocal) ?? []).filter((entry) => entry.fileName !== fileName),
        );
        return true;
      },
    };
    const app = createApp({ storage });

    const uploadAttempts = 5;
    const [deleteRes, ...uploadResponses] = await Promise.all([
      app.request(
        `/api/tickets/bdboard-1/attachments/${seed[0]?.fileName}`,
        withLocalHost({ method: 'DELETE' }),
        LOCAL_ENV,
      ),
      ...Array.from({ length: uploadAttempts }, () =>
        app.request(
          '/api/tickets/bdboard-1/attachments',
          withLocalHost({
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ mimeType: 'image/png', data: PNG_BASE64 }),
          }),
          LOCAL_ENV,
        ),
      ),
    ]);

    expect(deleteRes.status).toBe(200);
    const created = uploadResponses.filter((res) => res.status === 201);
    const limitReached = uploadResponses.filter((res) => res.status === 409);
    // Exactly one slot opened up (the delete), so at most one upload may succeed.
    expect(created).toHaveLength(1);
    expect(limitReached).toHaveLength(uploadAttempts - 1);

    const finalList = await storage.list(toProjectAttachmentKey('/tmp/p'), 'bdboard-1');
    expect(finalList).toHaveLength(ATTACHMENT_MAX_COUNT_PER_TICKET);
  });
});

describe('toProjectAttachmentKey', () => {
  it('is deterministic and distinguishes different roots with the same basename', () => {
    const a = toProjectAttachmentKey('/Users/a/src/bdboard');
    const b = toProjectAttachmentKey('/Users/b/src/bdboard');
    expect(a).not.toBe(b);
    expect(toProjectAttachmentKey('/Users/a/src/bdboard')).toBe(a);
    expect(a).toMatch(/^bdboard-[0-9a-f]{8}$/);
  });
});
