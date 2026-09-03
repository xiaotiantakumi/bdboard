import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { createAgentRunGuardMiddleware, type AgentRunGuardDeps } from './agent-run-guard.js';
import type { WriteGuardDeps } from './write-guard.js';

const LOCAL_HOST = 'localhost:8787';

const LOCAL_ENV = {
  incoming: {
    socket: {
      remoteAddress: '127.0.0.1',
      localPort: 8787,
    },
  },
};

const TUNNEL_ENV = LOCAL_ENV;
const CF_HEADER = { 'CF-Ray': 'abc123-NRT' } as const;
const JSON_HEADER = { 'Content-Type': 'application/json' } as const;
const SESSION_COOKIE = 'bdboard_tunnel_session=example-session-value';

function withLocalHost(init: RequestInit = {}): RequestInit {
  const headers = new Headers(init.headers);
  if (!headers.has('Host')) {
    headers.set('Host', LOCAL_HOST);
  }
  return { ...init, headers };
}

function allowingDeps(overrides: Partial<WriteGuardDeps> = {}): WriteGuardDeps {
  return {
    isTunnelWriteAllowed: () => true,
    hasTunnelSession: () => true,
    ...overrides,
  };
}

function createGuardedApp(
  deps: AgentRunGuardDeps,
  onNext: () => void = () => undefined,
): Hono {
  const app = new Hono();
  app.use('*', createAgentRunGuardMiddleware(deps));
  app.get('/api/agent-runs', (c) => {
    onNext();
    return c.json({ ok: true });
  });
  app.post('/api/agent-runs', (c) => {
    onNext();
    return c.json({ ok: true });
  });
  return app;
}

describe('createAgentRunGuardMiddleware', () => {
  it('allows local direct access even when remote agent runs are disabled', async () => {
    const onNext = vi.fn();
    const app = createGuardedApp(
      {
        isRemoteAgentRunAllowed: async () => false,
      },
      onNext,
    );

    const res = await app.request('/api/agent-runs', withLocalHost({}), LOCAL_ENV);
    expect(res.status).toBe(200);
    expect(onNext).toHaveBeenCalledOnce();
  });

  it('blocks remote tunnel access when remote agent runs are disabled', async () => {
    const onNext = vi.fn();
    const app = createGuardedApp(
      {
        writeAccess: allowingDeps(),
        isRemoteAgentRunAllowed: async () => false,
      },
      onNext,
    );

    const res = await app.request(
      '/api/agent-runs',
      { headers: { ...CF_HEADER, Cookie: SESSION_COOKIE } },
      TUNNEL_ENV,
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'remote agent runs are disabled' });
    expect(onNext).not.toHaveBeenCalled();
  });

  it('allows remote tunnel access when remote agent runs are enabled', async () => {
    const onNext = vi.fn();
    const app = createGuardedApp(
      {
        writeAccess: allowingDeps(),
        isRemoteAgentRunAllowed: async () => true,
      },
      onNext,
    );

    const res = await app.request(
      '/api/agent-runs',
      { headers: { ...CF_HEADER, Cookie: SESSION_COOKIE } },
      TUNNEL_ENV,
    );
    expect(res.status).toBe(200);
    expect(onNext).toHaveBeenCalledOnce();
  });

  it('applies CSRF protection for remote requests the same way as the write guard', async () => {
    const onNext = vi.fn();
    const app = createGuardedApp(
      {
        writeAccess: allowingDeps(),
        isRemoteAgentRunAllowed: async () => true,
      },
      onNext,
    );

    const res = await app.request(
      '/api/agent-runs',
      {
        method: 'POST',
        headers: {
          ...CF_HEADER,
          ...JSON_HEADER,
          'Sec-Fetch-Site': 'cross-site',
          Cookie: SESSION_COOKIE,
        },
        body: '{}',
      },
      TUNNEL_ENV,
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'cross-site write blocked' });
    expect(onNext).not.toHaveBeenCalled();
  });

  it('denies remote access when isRemoteAgentRunAllowed throws (fail-closed)', async () => {
    const onNext = vi.fn();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const app = createGuardedApp(
      {
        writeAccess: allowingDeps(),
        isRemoteAgentRunAllowed: async () => {
          throw new Error('store unavailable');
        },
      },
      onNext,
    );

    try {
      const res = await app.request(
        '/api/agent-runs',
        { headers: { ...CF_HEADER, Cookie: SESSION_COOKIE } },
        TUNNEL_ENV,
      );
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'remote agent runs are disabled' });
      expect(onNext).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('guards GET requests with write-guard authorization for remote callers', async () => {
    const onNext = vi.fn();
    const app = createGuardedApp(
      {
        isRemoteAgentRunAllowed: async () => true,
      },
      onNext,
    );

    const res = await app.request('/api/agent-runs', { headers: CF_HEADER }, TUNNEL_ENV);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'local access only' });
    expect(onNext).not.toHaveBeenCalled();
  });
});
