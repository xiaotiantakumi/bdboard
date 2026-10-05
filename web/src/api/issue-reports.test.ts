import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './http';
import {
  createManualIssueDraft,
  fetchIssueDraft,
  fetchIssueDraftImageBytes,
  patchIssueDraft,
  uploadIssueDraftImage,
  ISSUE_MANUAL_DRAFTS_API_PATH,
} from './issue-reports';

const ID = '1758812345678-a1b2c3d4e5f6a7b8';
const PATH = `/api/issue-reports/drafts/${ID}`;
const draftBody = { id: ID, title: 't', body: 'b' };

function jsonResponse(body: unknown, init: { status?: number; etag?: string } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: {
      'content-type': 'application/json',
      ...(init.etag !== undefined ? { ETag: init.etag } : {}),
    },
  });
}

/** 呼ばれた fetch の 2 つ目の引数 (RequestInit)。 */
function initOf(fetchMock: ReturnType<typeof vi.fn>): RequestInit {
  return fetchMock.mock.calls[0]?.[1] as RequestInit;
}

describe('issue report draft API client (bdboard-mqoa)', () => {
  afterEach(() => vi.unstubAllGlobals());

  // bdboard-8zwi: 再送の前に、付いている画像の中身を取って見比べる。
  describe('fetchIssueDraftImageBytes', () => {
    it('GETs the image url as given and returns the body bytes', async () => {
      const fetchMock = vi.fn(() => Promise.resolve(new Response(new Uint8Array([1, 2, 3]), { status: 200 })));
      vi.stubGlobal('fetch', fetchMock);
      const bytes = await fetchIssueDraftImageBytes(`${PATH}/images/1-aaaa.png`);
      expect(fetchMock).toHaveBeenCalledWith(`${PATH}/images/1-aaaa.png`, undefined);
      expect(Array.from(new Uint8Array(bytes))).toEqual([1, 2, 3]);
    });

    it('rejects with an ApiError that keeps the status when the server does not answer 2xx', async () => {
      vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(jsonResponse({ error: 'image not found' }, { status: 404 }))));
      const caught = await fetchIssueDraftImageBytes(`${PATH}/images/9-zzzz.png`).catch((error: unknown) => error);
      expect(caught).toBeInstanceOf(ApiError);
      expect(caught).toMatchObject({ status: 404 });
    });
  });

  describe('uploadIssueDraftImage', () => {
    const image = { fileName: 'image.png', url: '/image.png', byteLength: 3, createdAt: '2026-10-06T00:00:00Z' };
    it('POSTs JSON to the encoded image path with the expected header and body', async () => {
      const fetchMock = vi.fn(() => Promise.resolve(jsonResponse({ image }, { status: 201 })));
      vi.stubGlobal('fetch', fetchMock);
      await uploadIssueDraftImage('a/b', { mimeType: 'image/png', data: 'AAA' });
      expect(fetchMock).toHaveBeenCalledWith('/api/issue-reports/drafts/a%2Fb/images', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mimeType: 'image/png', data: 'AAA' }),
      });
    });
    it('returns the 201 response body unchanged', async () => {
      vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(jsonResponse({ image }, { status: 201 }))));
      await expect(uploadIssueDraftImage(ID, { mimeType: 'image/png', data: 'AAA' })).resolves.toEqual({ image });
    });
    it.each([
      [409, { error: 'image limit reached', code: 'image-limit-reached' }, 409, 'image-limit-reached'],
      [409, { error: 'draft is not pending', code: 'draft-not-pending' }, 409, 'draft-not-pending'],
      [507, { error: 'full', code: 'storage-full' }, 507, 'storage-full'],
      [400, { error: 'invalid image' }, 400, undefined],
    ])('preserves status and code for HTTP %s errors', async (status, body, expectedStatus, code) => {
      vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(jsonResponse(body, { status }))));
      const caught = await uploadIssueDraftImage(ID, { mimeType: 'image/png', data: 'AAA' }).catch((error: unknown) => error);
      expect(caught).toBeInstanceOf(ApiError);
      expect(caught).toMatchObject({ status: expectedStatus, ...(code !== undefined ? { code } : {}) });
    });
  });

  // bdboard-4y8q.6.8: 「新しく報告」の送信。POST の本文は { title, description } で、project は渡したときだけ入る。
  describe('createManualIssueDraft', () => {
    const response = {
      outcome: 'created' as const,
      draft: {
        id: ID,
        kind: 'C' as const,
        fingerprint: 'C:manual:0123456789abcdef',
        title: 't',
        status: 'pending' as const,
        occurrenceCount: 1,
        firstOccurredAt: '2026-10-06T00:00:00.000Z',
        lastOccurredAt: '2026-10-06T00:00:00.000Z',
        occurredProjectCount: 0,
      },
    };

    it('POSTs { title, description } as JSON, with no project key, and returns the 201 body as it is', async () => {
      const fetchMock = vi.fn(() => Promise.resolve(jsonResponse(response, { status: 201 })));
      vi.stubGlobal('fetch', fetchMock);
      await expect(createManualIssueDraft({ title: ' title ', description: 'line1\nline2' })).resolves.toEqual(response);
      expect(fetchMock).toHaveBeenCalledWith('/api/issue-reports/manual-drafts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: ' title ', description: 'line1\nline2' }),
      });
      expect(ISSUE_MANUAL_DRAFTS_API_PATH).toBe('/api/issue-reports/manual-drafts');
    });

    it('puts the project in the body as { name, path } when given', async () => {
      const fetchMock = vi.fn(() => Promise.resolve(jsonResponse(response, { status: 201 })));
      vi.stubGlobal('fetch', fetchMock);
      await createManualIssueDraft({ title: 't', description: 'd', project: { name: 'example-project', path: '/p' } });
      const sent = initOf(fetchMock).body;
      expect(typeof sent).toBe('string');
      expect(JSON.parse(typeof sent === 'string' ? sent : '')).toEqual({
        title: 't',
        description: 'd',
        project: { name: 'example-project', path: '/p' },
      });
    });

    it('rejects a 429 with an ApiError that keeps the status and the manual-rate-limited code', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(() => Promise.resolve(jsonResponse({ error: 'too many manual reports in the last hour', code: 'manual-rate-limited' }, { status: 429 }))),
      );
      const caught = await createManualIssueDraft({ title: 't', description: 'd' }).catch((error: unknown) => error);
      expect(caught).toBeInstanceOf(ApiError);
      expect(caught).toMatchObject({ status: 429, code: 'manual-rate-limited' });
    });
  });

  describe('fetchIssueDraft', () => {
    it('adds the ETag response header to the data so an edit can send it as If-Match', async () => {
      const fetchMock = vi.fn(() => Promise.resolve(jsonResponse({ draft: draftBody, images: [] }, { etag: '"abc123"' })));
      vi.stubGlobal('fetch', fetchMock);
      await expect(fetchIssueDraft(ID)).resolves.toEqual({ draft: draftBody, images: [], etag: '"abc123"' });
      expect(fetchMock).toHaveBeenCalledWith(PATH, undefined);
    });

    it('leaves etag out when the server sent no ETag header (an older server)', async () => {
      vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(jsonResponse({ draft: draftBody }))));
      const result = await fetchIssueDraft(ID);
      expect(result).toEqual({ draft: draftBody });
      expect('etag' in result).toBe(false);
    });

    it('does not send a conditional header itself (the browser HTTP cache owns If-None-Match)', async () => {
      const fetchMock = vi.fn(() => Promise.resolve(jsonResponse({ draft: draftBody }, { etag: '"abc123"' })));
      vi.stubGlobal('fetch', fetchMock);
      await fetchIssueDraft(ID);
      expect(initOf(fetchMock)).toBeUndefined();
    });
  });

  describe('patchIssueDraft', () => {
    it('sends If-Match when given one, and returns the ETag of the saved draft', async () => {
      const fetchMock = vi.fn(() => Promise.resolve(jsonResponse({ draft: draftBody, errorTextTrimmed: false }, { etag: '"next"' })));
      vi.stubGlobal('fetch', fetchMock);
      const result = await patchIssueDraft(ID, { title: 'New' }, { ifMatch: '"abc123"' });
      expect(result).toEqual({ draft: draftBody, errorTextTrimmed: false, etag: '"next"' });
      expect(fetchMock).toHaveBeenCalledWith(PATH, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', 'if-match': '"abc123"' },
        body: JSON.stringify({ title: 'New' }),
      });
    });

    // bdboard-q5pj: サーバーの ETag は "<editDigest>-<bodyDigest>" の形になった。web は中身を見ず、読んだ値をそのまま If-Match に付け、
    // 応答の ETag をそのまま持つ (形が変わっても web の変更は要らない)。
    it('treats the ETag as an opaque string: the "<editDigest>-<bodyDigest>" form is read, sent and kept as it is', async () => {
      const read = `"${'a'.repeat(32)}-${'b'.repeat(32)}"`;
      const saved = `"${'c'.repeat(32)}-${'d'.repeat(32)}"`;
      const fetchMock = vi.fn(() => Promise.resolve(jsonResponse({ draft: draftBody, errorTextTrimmed: false }, { etag: saved })));
      vi.stubGlobal('fetch', fetchMock);
      const result = await patchIssueDraft(ID, { title: 'New' }, { ifMatch: read });
      expect(result.etag).toBe(saved);
      expect(initOf(fetchMock).headers).toEqual({ 'content-type': 'application/json', 'if-match': read });
    });

    it('sends no If-Match header when none is given (the request is the same as before)', async () => {
      const fetchMock = vi.fn(() => Promise.resolve(jsonResponse({ draft: draftBody, errorTextTrimmed: false })));
      vi.stubGlobal('fetch', fetchMock);
      const result = await patchIssueDraft(ID, { body: '' });
      expect(result).toEqual({ draft: draftBody, errorTextTrimmed: false });
      expect('etag' in result).toBe(false);
      expect(initOf(fetchMock).headers).toEqual({ 'content-type': 'application/json' });
    });

    it('rejects a 412 with an ApiError that keeps the status and the error code', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(() =>
          Promise.resolve(jsonResponse({ error: 'draft was changed since it was read', code: 'precondition-failed' }, { status: 412 })),
        ),
      );
      const caught = await patchIssueDraft(ID, { title: 'New' }, { ifMatch: '"old"' }).catch((error: unknown) => error);
      expect(caught).toBeInstanceOf(ApiError);
      expect(caught).toMatchObject({ status: 412, code: 'precondition-failed' });
    });
  });
});
