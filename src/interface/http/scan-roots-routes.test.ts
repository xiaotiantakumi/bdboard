import { describe, expect, it, vi } from 'vitest';
import type { ScanRootsConfig, ScanRootsConfigPort } from '../../application/ports/scan-roots-config.js';
import { computeVersion, createScanRootsRoutes } from './scan-roots-routes.js';

const LOCAL_HOST = 'localhost:8787';

const LOCAL_ENV = { incoming: { socket: { remoteAddress: '127.0.0.1', localPort: 8787 } } };

function withLocalHost(init: RequestInit = {}): RequestInit {
  const headers = new Headers(init.headers);
  if (!headers.has('Host')) {
    headers.set('Host', LOCAL_HOST);
  }
  return { ...init, headers };
}
const EMPTY_VERSION = computeVersion(undefined);
const ONE_VERSION = computeVersion({ scanRoots: ['/one'], excludePaths: [] });
const TRIMMED_VERSION = computeVersion({ scanRoots: ['/one'], excludePaths: ['/tmp'] });

function makeStore(overrides: Partial<ScanRootsConfigPort> = {}): ScanRootsConfigPort {
  return {
    read: vi.fn(async () => undefined),
    write: vi.fn(async () => undefined),
    ...overrides,
  };
}

function makePersistedStore(initial?: ScanRootsConfig): ScanRootsConfigPort {
  let current = initial;
  return makeStore({
    read: vi.fn(async () => current),
    write: vi.fn(async (config) => {
      current = config;
    }),
  });
}

describe('createScanRootsRoutes', () => {
  it('returns empty defaults when no config exists', async () => {
    const response = await createScanRootsRoutes({ store: makeStore(), resolveDefaultScanRoots: vi.fn(async () => []) }).request(
      '/api/settings/scan-roots',
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      scanRoots: [],
      excludePaths: [],
      version: EMPTY_VERSION,
      defaultScanRoots: [],
      envOverride: false,
      envScanRoots: [],
    });
  });

  it('reports envOverride: true when BDBOARD_SCAN_ROOTS is set', async () => {
    const response = await createScanRootsRoutes({
      store: makeStore(),
      isEnvOverridden: true,
      envScanRoots: ['/env/one', '/env/two'],
      resolveDefaultScanRoots: vi.fn(async () => []),
    }).request('/api/settings/scan-roots');
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      scanRoots: [],
      excludePaths: [],
      version: EMPTY_VERSION,
      defaultScanRoots: [],
      envOverride: true,
      envScanRoots: ['/env/one', '/env/two'],
    });
  });

  it('returns resolved default scan roots when provided', async () => {
    const resolveDefaultScanRoots = vi.fn(async () => ['/Users/example', '/tmp/projects']);
    const response = await createScanRootsRoutes({
      store: makeStore({ read: vi.fn(async () => ({ scanRoots: [], excludePaths: [] })) }),
      resolveDefaultScanRoots,
    }).request('/api/settings/scan-roots');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      scanRoots: [],
      excludePaths: [],
      version: EMPTY_VERSION,
      defaultScanRoots: ['/Users/example', '/tmp/projects'],
      envOverride: false,
      envScanRoots: [],
    });
    expect(resolveDefaultScanRoots).toHaveBeenCalledOnce();
  });

  it('writes a valid, trimmed config', async () => {
    const store = makePersistedStore();
    const response = await createScanRootsRoutes({ store, resolveDefaultScanRoots: vi.fn(async () => []) }).request(
      '/api/settings/scan-roots',
      withLocalHost({
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scanRoots: [' /one '], excludePaths: [' /tmp '], version: EMPTY_VERSION }),
      }),
      LOCAL_ENV,
    );
    expect(response.status).toBe(200);
    expect(store.write).toHaveBeenCalledWith({ scanRoots: ['/one'], excludePaths: ['/tmp'] });
    await expect(response.json()).resolves.toEqual({
      scanRoots: ['/one'],
      excludePaths: ['/tmp'],
      version: TRIMMED_VERSION,
    });
  });

  it('normalizes trailing separators in excludePaths before writing', async () => {
    const store = makePersistedStore();
    const response = await createScanRootsRoutes({ store, resolveDefaultScanRoots: vi.fn(async () => []) }).request(
      '/api/settings/scan-roots',
      withLocalHost({
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          scanRoots: ['/one/'],
          excludePaths: ['/path/to/exclude/', 'C:\\Users\\example\\', '/', 'C:\\\\'],
          version: EMPTY_VERSION,
        }),
      }),
      LOCAL_ENV,
    );
    expect(response.status).toBe(200);
    expect(store.write).toHaveBeenCalledWith({
      scanRoots: ['/one/'],
      excludePaths: ['/path/to/exclude', 'C:\\Users\\example', '/', 'C:\\'],
    });
    await expect(response.json()).resolves.toMatchObject({
      version: computeVersion({
        scanRoots: ['/one/'],
        excludePaths: ['/path/to/exclude', 'C:\\Users\\example', '/', 'C:\\'],
      }),
    });
  });

  it.each([
    {},
    { scanRoots: 'not-array' },
    { scanRoots: ['   '] },
  ])('rejects invalid body %#', async (body) => {
    const response = await createScanRootsRoutes({ store: makeStore(), resolveDefaultScanRoots: vi.fn(async () => []) }).request(
      '/api/settings/scan-roots',
      withLocalHost({
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
      LOCAL_ENV,
    );
    expect(response.status).toBe(400);
  });

  it.each([
    ['/'],
    ['/etc'],
    ['/etc/../etc'],
    ['//usr'],
    ['/System/'],
    ['C:\\'],
    ['/Users/example', '/var'], // 安全なパスが混ざっていても1つでも危険なら拒否
  ])('rejects dangerous scan roots %j and does not write', async (...scanRoots) => {
    const store = makeStore();
    const response = await createScanRootsRoutes({ store, resolveDefaultScanRoots: vi.fn(async () => []) }).request(
      '/api/settings/scan-roots',
      withLocalHost({
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scanRoots, version: EMPTY_VERSION }),
      }),
      LOCAL_ENV,
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string; details: { rejected: string[] } };
    expect(body.error).toBe('dangerous scan root rejected');
    expect(body.details.rejected.length).toBeGreaterThan(0);
    expect(store.write).not.toHaveBeenCalled();
  });

  it('reports which roots were rejected', async () => {
    const response = await createScanRootsRoutes({ store: makeStore(), resolveDefaultScanRoots: vi.fn(async () => []) }).request(
      '/api/settings/scan-roots',
      withLocalHost({
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scanRoots: ['/Users/example', '/etc/../etc'], version: EMPTY_VERSION }),
      }),
      LOCAL_ENV,
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: 'dangerous scan root rejected',
      details: { rejected: ['/etc/../etc'] },
    });
  });

  it('still accepts deep subpaths of system directories', async () => {
    const store = makeStore();
    const response = await createScanRootsRoutes({ store, resolveDefaultScanRoots: vi.fn(async () => []) }).request(
      '/api/settings/scan-roots',
      withLocalHost({
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scanRoots: ['/usr/local/projects'], version: EMPTY_VERSION }),
      }),
      LOCAL_ENV,
    );
    expect(response.status).toBe(200);
    expect(store.write).toHaveBeenCalledWith({ scanRoots: ['/usr/local/projects'], excludePaths: [] });
  });

  it('rejects a stale version without writing', async () => {
    const store = makePersistedStore();
    const app = createScanRootsRoutes({ store, resolveDefaultScanRoots: vi.fn(async () => []) });
    await app.request('/api/settings/scan-roots', withLocalHost({
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scanRoots: ['/one'], excludePaths: [], version: EMPTY_VERSION }),
    }), LOCAL_ENV);

    const response = await app.request('/api/settings/scan-roots', withLocalHost({
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scanRoots: ['/two'], excludePaths: [], version: EMPTY_VERSION }),
    }), LOCAL_ENV);
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: 'scan roots config changed since read',
      requestedVersion: EMPTY_VERSION,
      currentVersion: ONE_VERSION,
    });
    expect(store.write).toHaveBeenCalledOnce();
  });

  it('serializes two concurrent PUTs with the same version so only one write happens (M1)', async () => {
    // Delay the fake write to exercise the await boundary inside the mutex.
    const store = makeStore();
    /* The fake store's read must observe the first completed write. */
    let persisted: { scanRoots: string[]; excludePaths: string[] } | undefined;
    store.read = vi.fn(async () => persisted);
    store.write = vi.fn(async (config) => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      persisted = config;
    });
    const app = createScanRootsRoutes({ store, resolveDefaultScanRoots: vi.fn(async () => []) });
    const putOnce = (path: string) =>
      app.request(
        '/api/settings/scan-roots',
        withLocalHost({
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ scanRoots: [path], excludePaths: [], version: EMPTY_VERSION }),
        }),
        LOCAL_ENV,
      );

    const [first, second] = await Promise.all([putOnce('/one'), putOnce('/two')]);
    const statuses = [first.status, second.status].sort((a, b) => a - b);
    expect(statuses).toEqual([200, 409]);
    expect(store.write).toHaveBeenCalledOnce();
  });

  it('detects an external edit made after GET', async () => {
    let current = { scanRoots: ['/one'], excludePaths: [] };
    const store = makeStore({ read: vi.fn(async () => current) });
    const app = createScanRootsRoutes({ store, resolveDefaultScanRoots: vi.fn(async () => []) });
    const read = await app.request('/api/settings/scan-roots');
    const { version } = (await read.json()) as { version: string };
    current = { scanRoots: ['/edited'], excludePaths: [] };
    const response = await app.request('/api/settings/scan-roots', withLocalHost({
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scanRoots: ['/two'], excludePaths: [], version }),
    }), LOCAL_ENV);
    expect(response.status).toBe(409);
    expect(store.write).not.toHaveBeenCalled();
  });

  it('returns the same version for identical content across route instances', async () => {
    const config = { scanRoots: ['/one'], excludePaths: ['/tmp'] };
    const makeApp = () => createScanRootsRoutes({
      store: makeStore({ read: vi.fn(async () => config) }),
      resolveDefaultScanRoots: vi.fn(async () => []),
    });
    const first = await makeApp().request('/api/settings/scan-roots');
    const second = await makeApp().request('/api/settings/scan-roots');
    expect((await first.json()).version).toBe((await second.json()).version);
  });

  it('treats scanRoots order as content, not as an equivalent reordering', () => {
    // If a future "normalize the order" refactor makes computeVersion order-insensitive, a
    // reordering PUT would fail to advance the version, letting a stale tab silently clobber a
    // reordering with its own stale content on the next write.
    const forward = computeVersion({ scanRoots: ['/a', '/b'], excludePaths: [] });
    const reversed = computeVersion({ scanRoots: ['/b', '/a'], excludePaths: [] });
    expect(forward).not.toBe(reversed);
  });

  it('computes a version that matches a golden constant, pinning the wire format', () => {
    // Golden value independently recomputed against this branch's computeVersion before pinning
    // here; a change to the hash algorithm, the normalized shape, or the encoding should be a
    // deliberate, reviewed decision, not a silent drift.
    expect(computeVersion({ scanRoots: ['/one'], excludePaths: [] })).toBe(
      '4559587c076322e67b8779559f166abe19cc8cd5eb793d898bd157c612c86ab4',
    );
  });

  it('accepts a version issued before a restart when the content is unchanged (restart acceptance)', async () => {
    // Unlike amj's Date.now()-seeded counter, a brand-new routes instance over unchanged content
    // computes the same version, so a tab that held a version from before a restart isn't hit
    // with a spurious 409 on its next PUT.
    const config = { scanRoots: ['/one'], excludePaths: [] };
    const preRestartApp = createScanRootsRoutes({
      store: makeStore({ read: vi.fn(async () => config) }),
      resolveDefaultScanRoots: vi.fn(async () => []),
    });
    const read = await preRestartApp.request('/api/settings/scan-roots');
    const { version: preRestartVersion } = (await read.json()) as { version: string };

    const store = makePersistedStore(config);
    const postRestartApp = createScanRootsRoutes({ store, resolveDefaultScanRoots: vi.fn(async () => []) });
    const response = await postRestartApp.request(
      '/api/settings/scan-roots',
      withLocalHost({
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scanRoots: ['/one', '/two'], excludePaths: [], version: preRestartVersion }),
      }),
      LOCAL_ENV,
    );
    expect(response.status).toBe(200);
    expect(store.write).toHaveBeenCalledOnce();
  });

  it('allows a retry with the same version after a write failure', async () => {
    const store = makePersistedStore();
    store.write = vi
      .fn()
      .mockRejectedValueOnce(new Error('disk full'))
      .mockImplementationOnce(async (config) => {
        await Promise.resolve(config);
      });
    const app = createScanRootsRoutes({ store, resolveDefaultScanRoots: vi.fn(async () => []) });
    const putVersion1 = () => app.request('/api/settings/scan-roots', withLocalHost({
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scanRoots: ['/one'], excludePaths: [], version: EMPTY_VERSION }),
    }), LOCAL_ENV);
    const failed = await putVersion1();
    expect(failed.status).toBe(500);
    const retried = await putVersion1();
    expect(retried.status).toBe(200);
    await expect(retried.json()).resolves.toMatchObject({ version: ONE_VERSION });
    expect(store.write).toHaveBeenCalledTimes(2);
  });

  it('requires version in PUT requests', async () => {
    const store = makeStore();
    const response = await createScanRootsRoutes({ store, resolveDefaultScanRoots: vi.fn(async () => []) }).request(
      '/api/settings/scan-roots',
      withLocalHost({
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scanRoots: ['/one'], excludePaths: [] }),
      }),
      LOCAL_ENV,
    );
    expect(response.status).toBe(400);
    expect(store.write).not.toHaveBeenCalled();
  });

  it('returns the content version after a successful write and rejects reuse of it', async () => {
    const store = makePersistedStore();
    const app = createScanRootsRoutes({ store, resolveDefaultScanRoots: vi.fn(async () => []) });
    const request = () => app.request('/api/settings/scan-roots', withLocalHost({
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scanRoots: ['/one'], excludePaths: [], version: EMPTY_VERSION }),
    }), LOCAL_ENV);
    const first = await request();
    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toMatchObject({ version: ONE_VERSION });
    const second = await request();
    expect(second.status).toBe(409);
    expect(store.write).toHaveBeenCalledOnce();
  });

  it('rejects a non-local unauthenticated write', async () => {
    const store = makeStore();
    const response = await createScanRootsRoutes({ store, resolveDefaultScanRoots: vi.fn(async () => []) }).request(
      '/api/settings/scan-roots',
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'cf-ray': 'abc' },
        body: JSON.stringify({ scanRoots: ['/one'] }),
      },
      { incoming: { socket: { remoteAddress: '192.0.2.1' } } },
    );
    expect(response.status).toBe(403);
    expect(store.write).not.toHaveBeenCalled();
  });
});
