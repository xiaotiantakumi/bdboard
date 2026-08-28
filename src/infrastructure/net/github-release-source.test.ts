import { describe, expect, it, vi } from 'vitest';
import { createGithubReleaseSource } from './github-release-source.js';

const REPO = 'xiaotiantakumi/bdboard';
const RELEASE_URL = 'https://github.com/xiaotiantakumi/bdboard/releases/tag/v2.0.0';

function jsonResponse(body: unknown, init?: { status?: number }): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function createSource(fetchImpl: typeof fetch, userAgent?: string) {
  return createGithubReleaseSource({
    repository: REPO,
    fetchImpl,
    ...(userAgent !== undefined ? { userAgent } : {}),
  });
}

describe('createGithubReleaseSource', () => {
  it('reads tag_name and html_url from the latest release', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ tag_name: 'v2.0.0', html_url: RELEASE_URL }),
    ) as unknown as typeof fetch;

    await expect(createSource(fetchImpl).fetchLatest()).resolves.toEqual({
      tag: 'v2.0.0',
      url: RELEASE_URL,
    });
  });

  it('requests the latest-release endpoint with the documented headers and a timeout', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ tag_name: 'v2.0.0', html_url: RELEASE_URL }),
    );

    await createSource(fetchImpl as unknown as typeof fetch, '1.0.0').fetchLatest();

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://api.github.com/repos/${REPO}/releases/latest`);
    const headers = init.headers as Record<string, string>;
    expect(headers.Accept).toBe('application/vnd.github+json');
    // GitHub API は User-Agent を要求する。自バージョンを載せておくと、
    // 向こう側のログから古い版の分布が見える。
    expect(headers['User-Agent']).toBe('bdboard/1.0.0');
    // タイムアウトを付けないと、オフラインや GitHub 障害時にリクエストが
    // 吊られたままになる。
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    ['404 (no release published yet)', 404],
    ['403 (rate limited)', 403],
    ['500 (github is down)', 500],
  ])('returns null on %s', async (_label, status) => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ message: 'nope' }, { status }),
    ) as unknown as typeof fetch;

    await expect(createSource(fetchImpl).fetchLatest()).resolves.toBeNull();
  });

  it('returns null when fetch rejects (offline, DNS failure, timeout)', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('getaddrinfo ENOTFOUND');
    }) as unknown as typeof fetch;

    await expect(createSource(fetchImpl).fetchLatest()).resolves.toBeNull();
  });

  it('returns null when the body is not valid JSON', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('<html>proxy error</html>', { status: 200 }),
    ) as unknown as typeof fetch;

    await expect(createSource(fetchImpl).fetchLatest()).resolves.toBeNull();
  });

  it.each([
    ['tag_name is missing', { html_url: RELEASE_URL }],
    ['tag_name is empty', { tag_name: '', html_url: RELEASE_URL }],
    ['html_url is missing', { tag_name: 'v2.0.0' }],
    ['html_url is not a url', { tag_name: 'v2.0.0', html_url: 'not a url' }],
    [
      'html_url is not https',
      { tag_name: 'v2.0.0', html_url: 'http://github.com/a/b/releases/tag/v2' },
    ],
    [
      'html_url points somewhere other than github.com',
      { tag_name: 'v2.0.0', html_url: 'https://evil.example.com/releases/tag/v2' },
    ],
    [
      'html_url is a javascript: url',
      { tag_name: 'v2.0.0', html_url: 'javascript:alert(1)' },
    ],
  ])('returns null when %s', async (_label, body) => {
    // 返ってきた URL はそのまま UI のリンクになるので、外部入力として検証する。
    const fetchImpl = vi.fn(async () => jsonResponse(body)) as unknown as typeof fetch;

    await expect(createSource(fetchImpl).fetchLatest()).resolves.toBeNull();
  });
});
