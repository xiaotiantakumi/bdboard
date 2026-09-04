import { describe, expect, it, vi } from 'vitest';
import type {
  AgentRunConfig,
  AgentRunConfigPort,
} from '../../application/ports/agent-run-config.js';
import { DEFAULT_ALLOW_REMOTE_AGENT_RUNS } from '../../domain/agent-run-policy.js';
import {
  computeAgentRunVersion,
  createAgentRunSettingsRoutes,
} from './agent-run-settings-routes.js';
import type { WriteGuardDeps } from './write-guard.js';

const LOCAL_HOST = 'localhost:8787';

const LOCAL_ENV = { incoming: { socket: { remoteAddress: '127.0.0.1', localPort: 8787 } } };

const TUNNEL_ENV = LOCAL_ENV;
const CF_HEADER = { 'cf-ray': 'abc123-NRT' } as const;
const SESSION_COOKIE = 'bdboard_tunnel_session=example-session-value';

function allowingDeps(overrides: Partial<WriteGuardDeps> = {}): WriteGuardDeps {
  return {
    isTunnelWriteAllowed: () => true,
    hasTunnelSession: () => true,
    ...overrides,
  };
}

function withLocalHost(init: RequestInit = {}): RequestInit {
  const headers = new Headers(init.headers);
  if (!headers.has('Host')) {
    headers.set('Host', LOCAL_HOST);
  }
  return { ...init, headers };
}
const EMPTY_VERSION = computeAgentRunVersion(undefined);

function makeStore(overrides: Partial<AgentRunConfigPort> = {}): AgentRunConfigPort {
  return {
    read: vi.fn(async () => undefined),
    write: vi.fn(async () => undefined),
    ...overrides,
  };
}

function makePersistedStore(initial?: AgentRunConfig): AgentRunConfigPort {
  let current = initial;
  return makeStore({
    read: vi.fn(async () => current),
    write: vi.fn(async (config) => {
      current = config;
    }),
  });
}

describe('createAgentRunSettingsRoutes', () => {
  it('returns default allowRemoteAgentRuns when no config exists', async () => {
    const response = await createAgentRunSettingsRoutes({ store: makeStore() }).request(
      '/api/settings/agent-runs',
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      allowRemoteAgentRuns: DEFAULT_ALLOW_REMOTE_AGENT_RUNS,
      version: EMPTY_VERSION,
      defaults: { allowRemoteAgentRuns: DEFAULT_ALLOW_REMOTE_AGENT_RUNS },
    });
  });

  it('writes a valid config', async () => {
    const store = makePersistedStore();
    const response = await createAgentRunSettingsRoutes({ store }).request(
      '/api/settings/agent-runs',
      withLocalHost({
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          allowRemoteAgentRuns: true,
          version: EMPTY_VERSION,
        }),
      }),
      LOCAL_ENV,
    );
    expect(response.status).toBe(200);
    expect(store.write).toHaveBeenCalledWith({ allowRemoteAgentRuns: true });
  });

  it('rejects invalid body with 400', async () => {
    const response = await createAgentRunSettingsRoutes({ store: makeStore() }).request(
      '/api/settings/agent-runs',
      withLocalHost({
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          allowRemoteAgentRuns: 'yes',
          version: EMPTY_VERSION,
        }),
      }),
      LOCAL_ENV,
    );
    expect(response.status).toBe(400);
  });

  it('returns 409 on version mismatch', async () => {
    const response = await createAgentRunSettingsRoutes({ store: makeStore() }).request(
      '/api/settings/agent-runs',
      withLocalHost({
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          allowRemoteAgentRuns: true,
          version: 'stale-version',
        }),
      }),
      LOCAL_ENV,
    );
    expect(response.status).toBe(409);
  });

  it('rejects a non-local unauthenticated write', async () => {
    const store = makeStore();
    const response = await createAgentRunSettingsRoutes({ store }).request(
      '/api/settings/agent-runs',
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'cf-ray': 'abc' },
        body: JSON.stringify({
          allowRemoteAgentRuns: true,
          version: EMPTY_VERSION,
        }),
      },
      { incoming: { socket: { remoteAddress: '192.0.2.1' } } },
    );
    expect(response.status).toBe(403);
    expect(store.write).not.toHaveBeenCalled();
  });

  it('rejects tunnel PUT even when write-guard would allow the session', async () => {
    const store = makeStore();
    const response = await createAgentRunSettingsRoutes({
      store,
      writeAccess: allowingDeps(),
    }).request(
      '/api/settings/agent-runs',
      {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          Host: LOCAL_HOST,
          ...CF_HEADER,
          Cookie: SESSION_COOKIE,
        },
        body: JSON.stringify({
          allowRemoteAgentRuns: true,
          version: EMPTY_VERSION,
        }),
      },
      TUNNEL_ENV,
    );
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: 'local access only' });
    expect(store.write).not.toHaveBeenCalled();
  });

  it('allows tunnel GET to read current settings', async () => {
    const response = await createAgentRunSettingsRoutes({
      store: makeStore(),
      writeAccess: allowingDeps(),
    }).request(
      '/api/settings/agent-runs',
      {
        headers: {
          Host: LOCAL_HOST,
          ...CF_HEADER,
          Cookie: SESSION_COOKIE,
        },
      },
      TUNNEL_ENV,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      allowRemoteAgentRuns: DEFAULT_ALLOW_REMOTE_AGENT_RUNS,
      version: EMPTY_VERSION,
      defaults: { allowRemoteAgentRuns: DEFAULT_ALLOW_REMOTE_AGENT_RUNS },
    });
  });
});
