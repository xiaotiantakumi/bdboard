import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './http';
import { createManualIssueDraft, fetchIssueDraft, patchIssueDraft, ISSUE_MANUAL_DRAFTS_API_PATH } from './issue-reports';

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

  it('creates a manual draft with an optional project and returns the server response', async () => {
    const response = { outcome: 'created' as const, draft: { id: ID, kind: 'A' as const, fingerprint: 'f', title: 't', status: 'pending' as const, occurrenceCount: 1, firstOccurredAt: 'now', lastOccurredAt: 'now', occurredProjectCount: 0 } };
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse(response, { status: 201 })));
    vi.stubGlobal('fetch', fetchMock);
    await expect(createManualIssueDraft({ title: ' title ', description: 'detail' })).resolves.toEqual(response);
    expect(fetchMock).toHaveBeenCalledWith(ISSUE_MANUAL_DRAFTS_API_PATH, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: ' title ', description: 'detail' }) });
    await createManualIssueDraft({ title: 't', description: 'd', project: { name: 'P', path: '/p' } });
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({ title: 't', description: 'd', project: { name: 'P', path: '/p' } });
  });

  it('preserves the manual rate limit code in ApiError', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(jsonResponse({ error: 'limited', code: 'manual-rate-limited' }, { status: 429 }))));
    await expect(createManualIssueDraft({ title: 't', description: 'd' })).rejects.toMatchObject({ status: 429, code: 'manual-rate-limited' });
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
