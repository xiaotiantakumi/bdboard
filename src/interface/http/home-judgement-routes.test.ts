import { describe, expect, it, vi } from 'vitest';
import { createHomeJudgementRoutes } from './home-judgement-routes.js';
import { requestLocal } from './local-file-routes-test-support.js';

const V4 = '203.0.113.42';
const V6 = '2001:db8:abcd:12::1';
const TUNNEL_URL = 'https://example.trycloudflare.com';

function createRoutes(addresses: { ipv4: string | null; ipv6: string | null } = { ipv4: V4, ipv6: V6 }) {
  let session = true;
  const probe = { probe: vi.fn().mockResolvedValue(addresses) };
  return {
    app: createHomeJudgementRoutes({
      tunnelService: { getState: () => ({ kind: 'on', url: TUNNEL_URL }) } as never,
      probe,
      writeAccess: { isTunnelWriteAllowed: () => true, hasTunnelSession: () => session },
    }),
    probe,
    setSession(value: boolean) { session = value; },
  };
}

async function tunnelRequest(app: ReturnType<typeof createRoutes>['app'], ip: string, headers: HeadersInit = {}) {
  return app.request('/api/tunnel/at-home', { headers: { 'cf-connecting-ip': ip, ...headers } });
}

describe('GET /api/tunnel/at-home', () => {
  it('denies a tunnel request without a session', async () => {
    const { app, setSession } = createRoutes();
    setSession(false);
    const response = await app.request('/api/tunnel/at-home', { headers: { 'cf-connecting-ip': V4 } });
    expect(response.status).toBe(403);
  });

  it('denies cross-site fetches', async () => {
    const { app } = createRoutes();
    const response = await app.request('/api/tunnel/at-home', {
      headers: { 'cf-connecting-ip': V4, 'sec-fetch-site': 'cross-site', cookie: 'session=valid' },
    });
    expect(response.status).toBe(403);
  });

  it('returns only the judgement and never exposes address values', async () => {
    const { app } = createRoutes();
    const response = await tunnelRequest(app, V4);
    const body = await response.text();
    expect(body).toContain('yes');
    expect(body).not.toContain(V4);
    expect(body).not.toContain(V6);
  });

  it.each([[V4, 'yes'], ['198.51.100.1', 'no'], ['2001:db8:abcd:12::ffff', 'yes'], ['2001:db8:abcd:13::1', 'no']] as const)(
    'judges %s as %s', async (ip, home) => {
      const { app } = createRoutes();
      const response = await tunnelRequest(app, ip);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ home });
    },
  );

  it.each([
    ['2001:db8:1::5', '2001:db8:1:0:abcd::1', 'yes'],
    ['2001:db8:1:0:abcd::1', '2001:db8:1::5', 'yes'],
    ['2001:db8:1:1:abcd::1', '2001:db8:1::5', 'no'],
  ] as const)('expands compressed IPv6 %s against %s', async (knownV6, clientV6, expected) => {
    const { app } = createRoutes({ ipv4: null, ipv6: knownV6 });
    const response = await tunnelRequest(app, clientV6);
    expect(await response.json()).toEqual({ home: expected });
  });

  it('treats IPv4-mapped IPv6 as an exact IPv4 match', async () => {
    const { app } = createRoutes({ ipv4: '1.2.3.4', ipv6: null });
    const response = await tunnelRequest(app, '::ffff:1.2.3.4');
    expect(await response.json()).toEqual({ home: 'yes' });
  });

  it('returns unknown when both public addresses are unknown', async () => {
    const { app } = createRoutes({ ipv4: null, ipv6: null });
    const response = await tunnelRequest(app, V4);
    expect(await response.json()).toEqual({ home: 'unknown' });
  });

  it('returns yes for a local direct request', async () => {
    const { app, probe } = createRoutes();
    const response = await requestLocal(app, '/api/tunnel/at-home');
    expect(await response.json()).toEqual({ home: 'yes' });
    expect(probe.probe).not.toHaveBeenCalled();
  });
});
