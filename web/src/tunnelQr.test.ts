import { describe, expect, it } from 'vitest';
import { buildTunnelTokenUrl, TUNNEL_TOKEN_QUERY_PARAM } from './tunnelQr';

describe('buildTunnelTokenUrl', () => {
  it('appends the token as the t query parameter', () => {
    const parsed = new URL(
      buildTunnelTokenUrl('https://example.trycloudflare.com', 'example-token'),
    );

    expect(parsed.searchParams.get(TUNNEL_TOKEN_QUERY_PARAM)).toBe('example-token');
  });

  it('does not include userinfo in the result', () => {
    const parsed = new URL(
      buildTunnelTokenUrl('https://example.trycloudflare.com', 'example-token'),
    );

    expect(parsed.username).toBe('');
    expect(parsed.password).toBe('');
  });

  it('preserves path and existing query parameters', () => {
    const parsed = new URL(
      buildTunnelTokenUrl(
        'https://example.trycloudflare.com/board?view=next',
        'example-token',
      ),
    );

    expect(parsed.pathname).toBe('/board');
    expect(parsed.searchParams.get('view')).toBe('next');
    expect(parsed.searchParams.get(TUNNEL_TOKEN_QUERY_PARAM)).toBe('example-token');
  });

  it('strips userinfo from the input URL', () => {
    const withUserinfo = new URL('https://example.trycloudflare.com/board');
    withUserinfo.username = 'example-user';
    withUserinfo.password = 'example-password';

    const parsed = new URL(
      buildTunnelTokenUrl(withUserinfo.toString(), 'example-token'),
    );

    expect(parsed.username).toBe('');
    expect(parsed.password).toBe('');
    expect(parsed.pathname).toBe('/board');
    expect(parsed.searchParams.get(TUNNEL_TOKEN_QUERY_PARAM)).toBe('example-token');
  });
});
