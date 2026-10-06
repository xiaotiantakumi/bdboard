import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeExternalList } from '../test/externalIssueFixtures';
import { ApiError } from './http';
import {
  EXTERNAL_ISSUES_API_PATH,
  EXTERNAL_ISSUES_REFRESH_API_PATH,
  fetchExternalIssues,
  refreshExternalIssues,
  refreshWaitSeconds,
} from './issue-reports-external';

/** bdboard-4y8q.9.5: 届いた issue の API 呼び出し。 */

function stubFetch(response: Partial<Response> & { json?: () => Promise<unknown> }) {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, statusText: 'OK', ...response });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

describe('fetchExternalIssues / refreshExternalIssues', () => {
  it('reads the list with a plain GET (the server never starts a check on a read)', async () => {
    const list = makeExternalList();
    const fetchMock = stubFetch({ json: () => Promise.resolve(list) });

    await expect(fetchExternalIssues()).resolves.toEqual(list);

    expect(EXTERNAL_ISSUES_API_PATH).toBe('/api/issue-reports/external');
    expect(fetchMock).toHaveBeenCalledWith(EXTERNAL_ISSUES_API_PATH, undefined);
  });

  it('asks for a check with a POST that has a JSON content-type (the CSRF check needs it)', async () => {
    const list = makeExternalList({ state: 'error', error: { kind: 'failed', detail: '' } });
    const fetchMock = stubFetch({ json: () => Promise.resolve(list) });

    await expect(refreshExternalIssues()).resolves.toEqual(list);

    expect(EXTERNAL_ISSUES_REFRESH_API_PATH).toBe('/api/issue-reports/external/refresh');
    expect(fetchMock).toHaveBeenCalledWith(EXTERNAL_ISSUES_REFRESH_API_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
  });

  it('throws an ApiError that keeps the 429 body, so the wait seconds can be read', async () => {
    const body = JSON.stringify({ error: 'refresh is limited to once per minute', code: 'refresh-rate-limited', retryAfterSeconds: 31 });
    stubFetch({ ok: false, status: 429, statusText: 'Too Many Requests', text: () => Promise.resolve(body) });

    const error = await refreshExternalIssues().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect(refreshWaitSeconds(error)).toBe(31);
  });
});

describe('refreshWaitSeconds', () => {
  it.each([
    ['a positive integer', new ApiError(429, 'x', { body: '{"retryAfterSeconds":42}' }), 42],
    ['a missing field', new ApiError(429, 'x', { body: '{}' }), undefined],
    ['a body that is not JSON', new ApiError(429, 'x', { body: 'bad' }), undefined],
    ['no body', new ApiError(429, 'x'), undefined],
    ['zero', new ApiError(429, 'x', { body: '{"retryAfterSeconds":0}' }), undefined],
    ['a fraction', new ApiError(429, 'x', { body: '{"retryAfterSeconds":1.5}' }), undefined],
    ['a string', new ApiError(429, 'x', { body: '{"retryAfterSeconds":"42"}' }), undefined],
    ['another status', new ApiError(500, 'x', { body: '{"retryAfterSeconds":42}' }), undefined],
    ['an error that is not an ApiError', new Error('network'), undefined],
    ['something that is not an error', 'text', undefined],
  ])('reads %s', (_label, error, expected) => {
    expect(refreshWaitSeconds(error)).toBe(expected);
  });
});
