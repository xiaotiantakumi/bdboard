import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './http';
import {
  fetchLocalFileList,
  fetchLocalFileText,
  fetchTicketLocalFiles,
  localFileRawUrl,
} from './local-files';

const TICKET_ID = 'a/b c';
const BASE = `/api/tickets/${encodeURIComponent(TICKET_ID)}/local-files`;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('local file API client', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('fetches the ticket file list from the encoded ticket path', async () => {
    const files = [{ path: 'projects/demo/script/scenes.json', kind: 'json', size: 12 }];
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse({ files })));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchTicketLocalFiles(TICKET_ID)).resolves.toEqual({ files });
    expect(fetchMock).toHaveBeenCalledWith(BASE, undefined);
    expect(BASE).toBe('/api/tickets/a%2Fb%20c/local-files');
  });

  it('encodes the directory path on the list URL', async () => {
    const dirPath = 'out/13 demo/stills';
    const body = { path: dirPath, entries: [], truncated: false };
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse(body)));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchLocalFileList(TICKET_ID, dirPath)).resolves.toEqual(body);
    expect(fetchMock).toHaveBeenCalledWith(
      `${BASE}/list?path=${encodeURIComponent(dirPath)}`,
      undefined,
    );
    expect(encodeURIComponent(dirPath)).toBe('out%2F13%20demo%2Fstills');
  });

  it('builds the raw URL with encodeURIComponent for the ticket id and the path', () => {
    const path = 'out/13 demo/reading-review.mp4';
    expect(localFileRawUrl(TICKET_ID, path)).toBe(
      `${BASE}/raw?path=${encodeURIComponent(path)}`,
    );
    expect(encodeURIComponent(path)).toBe('out%2F13%20demo%2Freading-review.mp4');
  });

  it('returns the response text when the raw file is ok', async () => {
    const path = 'projects/demo/script/review.md';
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('hello\n', { status: 200 }))),
    );

    await expect(fetchLocalFileText(TICKET_ID, path)).resolves.toBe('hello\n');
  });

  it('throws ApiError with the status when the raw file is not ok', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(jsonResponse({ error: 'too large' }, 413))),
    );

    const caught = await fetchLocalFileText(TICKET_ID, 'big.mp4').catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(ApiError);
    expect(caught).toMatchObject({ status: 413, errorMessage: 'too large' });
  });
});
