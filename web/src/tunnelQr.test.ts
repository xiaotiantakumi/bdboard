import { describe, expect, it } from 'vitest';
import { parseProjectsParam } from './selectedProjectsBootstrap';
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

  it('omits projects when the selection is empty (all projects)', () => {
    const url = buildTunnelTokenUrl('https://example.trycloudflare.com', 'example-token', []);
    expect(new URL(url).searchParams.has('projects')).toBe(false);
  });

  it('carries the PC selection as comma-separated encoded ids (bdboard-u8p9)', () => {
    const url = buildTunnelTokenUrl('https://example.trycloudflare.com', 'example-token', [
      '/Users/me/video gen',
      '/Users/me/other',
    ]);
    expect(url).toContain('t=example-token');
    expect(url).toContain('projects=%2FUsers%2Fme%2Fvideo%20gen,%2FUsers%2Fme%2Fother');
    expect(parseProjectsParam(new URL(url).search)).toEqual([
      '/Users/me/video gen',
      '/Users/me/other',
    ]);
  });
});
