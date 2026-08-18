import { vi } from 'vitest';
import type { TunnelDto } from '../api';

const OFF_TUNNEL: TunnelDto = {
  state: 'off',
  available: true,
  authEnabled: true,
};

export type TunnelFetchMockOptions = {
  accessTokenStatus?: number;
};

export function countTunnelStartPosts(fetchMock: ReturnType<typeof vi.fn>): number {
  return fetchMock.mock.calls.filter(
    ([url, init]) =>
      url === '/api/tunnel/start' &&
      (init as RequestInit | undefined)?.method === 'POST',
  ).length;
}

export function countTunnelAccessTokenPosts(
  fetchMock: ReturnType<typeof vi.fn>,
): number {
  return fetchMock.mock.calls.filter(
    ([url, init]) =>
      url === '/api/tunnel/access-token' &&
      (init as RequestInit | undefined)?.method === 'POST',
  ).length;
}

export function countTunnelDismissPosts(
  fetchMock: ReturnType<typeof vi.fn>,
): number {
  return fetchMock.mock.calls.filter(
    ([url, init]) =>
      url === '/api/tunnel/interruption/dismiss' &&
      (init as RequestInit | undefined)?.method === 'POST',
  ).length;
}

function tunnelResponseWithoutInterruption(tunnelResponse: TunnelDto): TunnelDto {
  const { interruptedAt: _interruptedAt, ...cleared } = tunnelResponse;
  return cleared as TunnelDto;
}

export function installTunnelFetchMock(
  tunnelResponse: TunnelDto = OFF_TUNNEL,
  options: TunnelFetchMockOptions = {},
): ReturnType<typeof vi.fn> {
  const accessTokenStatus = options.accessTokenStatus ?? 200;
  const futureExpires = new Date(Date.now() + 5 * 60 * 1000).toISOString();

  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/tunnel' && (init?.method ?? 'GET') === 'GET') {
      return new Response(JSON.stringify(tunnelResponse), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url === '/api/tunnel/start' && init?.method === 'POST') {
      return new Response(
        JSON.stringify({
          state: 'starting',
          available: true,
          authEnabled: tunnelResponse.authEnabled,
        } satisfies TunnelDto),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    }

    if (url === '/api/tunnel/access-token' && init?.method === 'POST') {
      if (accessTokenStatus !== 200) {
        return new Response(JSON.stringify({ error: 'tunnel is not running' }), {
          status: accessTokenStatus,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      return new Response(
        JSON.stringify({ token: 'example-token', expiresAt: futureExpires }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    }

    if (url === '/api/tunnel/interruption/dismiss' && init?.method === 'POST') {
      return new Response(
        JSON.stringify(tunnelResponseWithoutInterruption(tunnelResponse)),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    }

    throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
  });

  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}
