import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import {
  hasCloudflareTunnelHeaders,
  hasExpectedLocalHost,
  isLocalBasicAuthRequest,
  isLocalControlRequest,
  isLoopbackAddress,
  readLocalPort,
  readRemoteAddress,
} from './local-request.js';

function socketEnv(remoteAddress: string, localPort = 8787) {
  return { incoming: { socket: { remoteAddress, localPort } } };
}

function createProbeApp() {
  const app = new Hono();
  app.get('/', (c) =>
    c.json({
      control: isLocalControlRequest(c),
      basicAuth: isLocalBasicAuthRequest(c),
    }),
  );
  return app;
}

describe('local request socket helpers', () => {
  it.each(['127.0.0.1', '::1', '::ffff:127.0.0.1'])(
    'accepts loopback address %s',
    (address) => {
      expect(isLoopbackAddress(address)).toBe(true);
    },
  );

  it('rejects non-loopback addresses', () => {
    expect(isLoopbackAddress('192.0.2.10')).toBe(false);
  });

  it('reads remote address and local port fail-closed', () => {
    expect(readRemoteAddress(socketEnv('::1'))).toBe('::1');
    expect(readLocalPort(socketEnv('::1'))).toBe(8787);
    expect(readRemoteAddress({})).toBeNull();
    expect(readLocalPort({ incoming: { socket: { localPort: '8787' } } })).toBeNull();
  });
});

describe('Cloudflare and Host restrictions', () => {
  it('detects cf-visitor even when it is the only Cloudflare header', () => {
    expect(hasCloudflareTunnelHeaders(new Headers({ 'cf-visitor': '{}' }))).toBe(true);
  });

  it.each(['localhost:8787', '127.0.0.1:8787', '[::1]:8787'])(
    'allows local Host %s on the actual port',
    (host) => {
      expect(hasExpectedLocalHost(new Headers({ Host: host }), 8787)).toBe(true);
    },
  );

  it('rejects DNS-rebinding hosts, wrong ports, and missing Host', () => {
    expect(
      hasExpectedLocalHost(new Headers({ Host: 'attacker.example:8787' }), 8787),
    ).toBe(false);
    expect(hasExpectedLocalHost(new Headers({ Host: 'localhost:5173' }), 8787)).toBe(false);
    expect(hasExpectedLocalHost(new Headers(), 8787)).toBe(false);
  });

  it('requires loopback, no Cloudflare headers, and an expected Host for auth bypass', async () => {
    const app = createProbeApp();

    const local = await app.request(
      '/',
      { headers: { Host: 'localhost:8787' } },
      socketEnv('::ffff:127.0.0.1'),
    );
    expect(await local.json()).toEqual({ control: true, basicAuth: true });

    const cloudflare = await app.request(
      '/',
      { headers: { Host: 'localhost:8787', 'cf-visitor': '{}' } },
      socketEnv('127.0.0.1'),
    );
    expect(await cloudflare.json()).toEqual({ control: false, basicAuth: false });

    const rebound = await app.request(
      '/',
      { headers: { Host: 'attacker.example:8787' } },
      socketEnv('127.0.0.1'),
    );
    expect(await rebound.json()).toEqual({ control: true, basicAuth: false });
  });
});
