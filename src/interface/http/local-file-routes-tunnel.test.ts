import type { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { createLocalFileRoutes } from './local-file-routes.js';
import {
  createFakeLocalFilesCache,
  createFakeLocalFs,
} from './local-file-routes-test-support.js';
import type { WriteGuardDeps } from './write-guard.js';

// bdboard-teir: 強パスワードのトンネル + セッション Cookie のときだけ、トンネル経由でも開ける。
const raw = (p: string) => `/api/tickets/video-1/local-files/raw?path=${encodeURIComponent(p)}`;
const COLLECTION = '/api/tickets/video-1/local-files';
const LIST = '/api/tickets/video-1/local-files/list?path=stills';

const fs = createFakeLocalFs();
fs.addFile('clip.mp4', Buffer.alloc(1024, 1));
fs.addFile('stills/s1.png', 'png');

function appWith(writeAccess: WriteGuardDeps | undefined): Hono {
  return createLocalFileRoutes({
    cache: createFakeLocalFilesCache({ description: 'clip.mp4' }),
    fs,
    ...(writeAccess === undefined ? {} : { writeAccess }),
  });
}

function tunnelRequest(app: Hono, url: string, headers: Record<string, string> = {}) {
  return Promise.resolve(
    app.request(
      url,
      { headers: { Host: 'example.trycloudflare.com', 'cf-connecting-ip': '203.0.113.5', ...headers } },
      { incoming: { socket: { remoteAddress: '127.0.0.1', localPort: 8787 } } },
    ),
  );
}

const open: WriteGuardDeps = { isTunnelWriteAllowed: () => true, hasTunnelSession: () => true };
const urls = [raw('clip.mp4'), COLLECTION, LIST] as const;

describe.each(urls)('tunnel access %s', (url) => {
  it('allows a strong-password tunnel with a session cookie', async () => {
    const res = await tunnelRequest(appWith(open), url, { 'Sec-Fetch-Site': 'same-origin' });
    expect(res.status).toBe(200);
  });

  it('denies a tunnel without a session', async () => {
    const res = await tunnelRequest(
      appWith({ isTunnelWriteAllowed: () => true, hasTunnelSession: () => false }),
      url,
    );
    expect(res.status).toBe(403);
  });

  it('denies a tunnel whose password is weak even with a session', async () => {
    const res = await tunnelRequest(
      appWith({ isTunnelWriteAllowed: () => false, hasTunnelSession: () => true }),
      url,
    );
    expect(res.status).toBe(403);
  });

  it('denies a tunnel when no writeAccess is wired', async () => {
    expect((await tunnelRequest(appWith(undefined), url)).status).toBe(403);
  });

  it.each(['none', 'cross-site', 'same-site'] as const)(
    'keeps denying Sec-Fetch-Site: %s on an authorized tunnel',
    async (site) => {
      const res = await tunnelRequest(appWith(open), url, { 'Sec-Fetch-Site': site });
      expect(res.status).toBe(403);
    },
  );
});

describe('tunnel video playback', () => {
  it('serves a Range request with 206 for an authorized session', async () => {
    const res = await tunnelRequest(appWith(open), raw('clip.mp4'), {
      'Sec-Fetch-Site': 'same-origin',
      Range: 'bytes=0-99',
    });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 0-99/1024');
    expect((await res.arrayBuffer()).byteLength).toBe(100);
  });

  it('still contains the path inside the project root', async () => {
    const res = await tunnelRequest(appWith(open), raw('../secret.txt'), {
      'Sec-Fetch-Site': 'same-origin',
    });
    expect(res.status).not.toBe(200);
  });
});
