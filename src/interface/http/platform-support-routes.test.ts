import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { describePlatformSupport } from '../../domain/platform-support.js';
import {
  createPlatformFeatureGuard,
  createPlatformSupportRoutes,
} from './platform-support-routes.js';

async function get(app: Hono, path: string): Promise<Response> {
  return await app.request(new Request(`http://localhost${path}`));
}

describe('GET /api/platform-support', () => {
  it('reports an empty limitation list on a fully supported platform', async () => {
    const app = createPlatformSupportRoutes({
      platformSupport: describePlatformSupport('darwin'),
    });

    const res = await get(app, '/api/platform-support');
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ platform: 'darwin', limitations: [] });
  });

  it('reports each limitation with a reason and a detail on win32', async () => {
    const app = createPlatformSupportRoutes({
      platformSupport: describePlatformSupport('win32'),
    });

    const body = (await (await get(app, '/api/platform-support')).json()) as {
      platform: string;
      limitations: { feature: string; reason: string; detail: string }[];
    };

    expect(body.platform).toBe('win32');
    expect(body.limitations.map((l) => l.feature).sort()).toEqual([
      'chat',
      'session-discovery',
    ]);
    for (const limitation of body.limitations) {
      expect(limitation.reason).not.toBe('');
      expect(limitation.detail).not.toBe('');
    }
  });
});

describe('createPlatformFeatureGuard', () => {
  function guardedApp(platform: string): { app: Hono; handler: ReturnType<typeof vi.fn> } {
    const handler = vi.fn(() => new Response('ok'));
    const app = new Hono();
    app.use(
      '/api/chat/*',
      createPlatformFeatureGuard(describePlatformSupport(platform), 'chat'),
    );
    app.all('/api/chat/*', handler);
    return { app, handler };
  }

  it('passes the request through on a supported platform', async () => {
    const { app, handler } = guardedApp('darwin');

    const res = await get(app, '/api/chat/sessions');
    expect(res.status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('answers 501 and never reaches the handler on an unsupported platform', async () => {
    const { app, handler } = guardedApp('win32');

    const res = await get(app, '/api/chat/sessions');
    // 500 ではなく 501。「壊れた」ではなく「そもそも対応していない」ことが
    // クライアントから区別できる必要がある (bdboard-70z.9)。
    expect(res.status).toBe(501);
    expect(handler).not.toHaveBeenCalled();
    await expect(res.json()).resolves.toMatchObject({
      error: 'platform-unsupported',
      feature: 'chat',
      platform: 'win32',
    });
  });

  it('includes a human-readable reason in the 501 body', async () => {
    const { app } = guardedApp('win32');

    const body = (await (await get(app, '/api/chat/sessions')).json()) as {
      reason: string;
      detail: string;
    };
    // 理由の無い 501 は、黙って動かないのとほとんど変わらない。
    expect(body.reason).toContain('Windows');
    expect(body.detail).not.toBe('');
  });

  it('guards a different feature independently', async () => {
    const handler = vi.fn(() => new Response('ok'));
    const app = new Hono();
    app.use(
      '/api/processes',
      createPlatformFeatureGuard(describePlatformSupport('win32'), 'session-discovery'),
    );
    app.get('/api/processes', handler);

    const res = await get(app, '/api/processes');
    expect(res.status).toBe(501);
    await expect(res.json()).resolves.toMatchObject({ feature: 'session-discovery' });
  });
});
