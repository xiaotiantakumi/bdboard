import { describe, expect, it } from 'vitest';
import { createLocalFileRoutes } from './local-file-routes.js';
import {
  createFakeLocalFilesCache,
  createFakeLocalFs,
  requestLocal,
} from './local-file-routes-test-support.js';

const MIB = 1024 * 1024;
const raw = (p: string) =>
  `/api/tickets/video-1/local-files/raw?path=${encodeURIComponent(p)}`;

const COLLECTION = '/api/tickets/video-1/local-files';
const LIST_STILLS = '/api/tickets/video-1/local-files/list?path=stills';
const MARKDOWN = 'text/markdown; charset=utf-8';
const JSON_TYPE = 'application/json; charset=utf-8';
const NUMS = '0123456789abcdefghijklmnopqrstuvwxyz';

const fs = createFakeLocalFs();
fs.addFile('a.md', '# hello');
fs.addFile('big.mp4', Buffer.alloc(10 * MIB, 1));
fs.addFile('nums.json', NUMS);
fs.addFile('huge.md', Buffer.alloc(2 * MIB + 1, 0x61));
fs.addFile('ok.md', Buffer.alloc(2 * MIB));
fs.addFile('clip.mp4', Buffer.alloc(4 * MIB + 1));
fs.addFile('x.svg', '<svg/>');
fs.addFile('x.html', '<!doctype html>');
fs.addFile('x.ts', 'export {};');
fs.addFile('stills/s1.png', 'png');

const app = createLocalFileRoutes({
  cache: createFakeLocalFilesCache({}),
  fs,
});

function expectServed(response: Response, contentType: string, byteLength: number): void {
  expect(response.headers.get('content-type')).toBe(contentType);
  expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  expect(response.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(response.headers.get('accept-ranges')).toBe('bytes');
  expect(response.headers.get('content-length')).toBe(String(byteLength));
}

describe('GET /api/tickets/:id/local-files/raw', () => {
  it('serves markdown with nosniff, a sandbox CSP, and no-store', async () => {
    const response = await requestLocal(app, raw('a.md'));

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('# hello');
    expectServed(response, MARKDOWN, 7);
  });

  it('caps bytes=0- at 4 MiB and does not read the whole file', async () => {
    const before = fs.readRangeCalls.length;
    const response = await requestLocal(app, raw('big.mp4'), { Range: 'bytes=0-' });

    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe(`bytes 0-${4 * MIB - 1}/${10 * MIB}`);
    expect((await response.arrayBuffer()).byteLength).toBe(4 * MIB);
    expectServed(response, 'video/mp4', 4 * MIB);
    expect(fs.readRangeCalls.slice(before)).toEqual([
      expect.objectContaining({ start: 0, length: 4 * MIB }),
    ]);
  });

  it('returns a single closed range with nosniff and a sandbox CSP', async () => {
    const response = await requestLocal(app, raw('nums.json'), { Range: 'bytes=10-19' });

    expect(response.status).toBe(206);
    expect(await response.text()).toBe('abcdefghij');
    expect(response.headers.get('content-range')).toBe('bytes 10-19/36');
    expectServed(response, JSON_TYPE, 10);
  });

  it('answers an unsatisfiable range with 416', async () => {
    const response = await requestLocal(app, raw('nums.json'), { Range: 'bytes=100-' });

    expect(response.status).toBe(416);
    expect(response.headers.get('content-range')).toBe('bytes */36');
  });

  it('ignores a multi-range header and returns the whole file', async () => {
    const response = await requestLocal(app, raw('nums.json'), { Range: 'bytes=0-1,5-6' });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(NUMS);
    expectServed(response, JSON_TYPE, NUMS.length);
  });

  it('rejects markdown over 2 MiB and serves a file of exactly 2 MiB', async () => {
    const huge = await requestLocal(app, raw('huge.md'));
    expect(huge.status).toBe(413);

    const ok = await requestLocal(app, raw('ok.md'));
    expect(ok.status).toBe(200);
    expect((await ok.arrayBuffer()).byteLength).toBe(2 * MIB);
    expectServed(ok, MARKDOWN, 2 * MIB);
  });

  it('rejects an unranged video over 4 MiB and serves bytes=0- as 206', async () => {
    const whole = await requestLocal(app, raw('clip.mp4'));
    expect(whole.status).toBe(413);

    const ranged = await requestLocal(app, raw('clip.mp4'), { Range: 'bytes=0-' });
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get('content-range')).toBe(`bytes 0-${4 * MIB - 1}/${4 * MIB + 1}`);
    expect((await ranged.arrayBuffer()).byteLength).toBe(4 * MIB);
    expectServed(ranged, 'video/mp4', 4 * MIB);
  });

  it.each([
    ['/api/tickets/video-1/local-files/raw', 400],
    [raw('../x.md'), 400],
    [raw('missing.md'), 404],
    [raw('x.svg'), 415],
    [raw('x.html'), 415],
    [raw('x.ts'), 415],
  ] as const)('%s -> %i', async (url, status) => {
    const response = await requestLocal(app, url);
    expect(response.status).toBe(status);
  });

  it('rejects a directory', async () => {
    const response = await requestLocal(app, raw('stills'));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'not a file' });
  });

  it('sends one strong ETag on two chunks, on 200, and on 416', async () => {
    const etag = '"24-0"';
    const first = await requestLocal(app, raw('nums.json'), { Range: 'bytes=0-9' });
    const second = await requestLocal(app, raw('nums.json'), { Range: 'bytes=10-19' });
    const whole = await requestLocal(app, raw('nums.json'));
    const unsatisfied = await requestLocal(app, raw('nums.json'), { Range: 'bytes=100-' });

    expect(first.status).toBe(206);
    expect(second.status).toBe(206);
    expect(whole.status).toBe(200);
    expect(unsatisfied.status).toBe(416);
    expect(first.headers.get('etag')).toBe(etag);
    expect(second.headers.get('etag')).toBe(etag);
    expect(whole.headers.get('etag')).toBe(etag);
    expect(unsatisfied.headers.get('etag')).toBe(etag);
  });

  it('changes the ETag when the size or the mtime changes', async () => {
    const varied = createFakeLocalFs();
    varied.addFile('same-size-a.mp4', Buffer.alloc(5 * MIB), 1000);
    varied.addFile('same-size-b.mp4', Buffer.alloc(5 * MIB), 2000);
    varied.addFile('other-size.mp4', Buffer.alloc(5 * MIB + 7), 1000);
    varied.addFile('fractional.mp4', Buffer.alloc(5 * MIB), 1000.75);
    const variedApp = createLocalFileRoutes({ cache: createFakeLocalFilesCache({}), fs: varied });
    const headers = { Range: 'bytes=0-0' };

    const sameSizeA = await requestLocal(variedApp, raw('same-size-a.mp4'), headers);
    const sameSizeB = await requestLocal(variedApp, raw('same-size-b.mp4'), headers);
    const otherSize = await requestLocal(variedApp, raw('other-size.mp4'), headers);

    expect(sameSizeA.headers.get('etag')).toBe('"500000-3e8"');
    expect(sameSizeB.headers.get('etag')).toBe('"500000-7d0"');
    expect(otherSize.headers.get('etag')).toBe('"500007-3e8"');
    const fractional = await requestLocal(variedApp, raw('fractional.mp4'), headers);
    expect(fractional.headers.get('etag')).toBe('"500000-3e8"');
  });

  it('never returns 206 when If-Range is not the current ETag', async () => {
    const varied = createFakeLocalFs();
    varied.addFile('nums.json', NUMS);
    varied.addFile('clip.mp4', Buffer.alloc(5 * MIB), 1000);
    const variedApp = createLocalFileRoutes({ cache: createFakeLocalFilesCache({}), fs: varied });
    const current = '"24-0"';

    const mismatch = await requestLocal(variedApp, raw('nums.json'), {
      Range: 'bytes=0-9',
      'If-Range': '"0-0"',
    });
    const weak = await requestLocal(variedApp, raw('nums.json'), {
      Range: 'bytes=0-9',
      'If-Range': `W/${current}`,
    });
    const tooBig = await requestLocal(variedApp, raw('clip.mp4'), {
      Range: 'bytes=0-9',
      'If-Range': '"0-0"',
    });
    const match = await requestLocal(variedApp, raw('nums.json'), {
      Range: 'bytes=0-9',
      'If-Range': current,
    });

    expect(mismatch.status).toBe(200);
    expect(await mismatch.text()).toBe(NUMS);
    expect(mismatch.headers.get('etag')).toBe(current);
    expect(weak.status).toBe(200);
    expect(tooBig.status).toBe(413);
    expect(match.status).toBe(206);
    expect(match.headers.get('etag')).toBe(current);
  });
});

describe.each([raw('a.md'), COLLECTION, LIST_STILLS] as const)('privileged guard %s', (url) => {
  it('rejects a Cloudflare tunnel header', async () => {
    const response = await requestLocal(app, url, { 'cf-connecting-ip': '203.0.113.5' });
    expect(response.status).toBe(403);
  });

  it.each(['cross-site', 'same-site', 'none'] as const)(
    'rejects Sec-Fetch-Site: %s',
    async (site) => {
      const response = await requestLocal(app, url, { 'Sec-Fetch-Site': site });
      expect(response.status).toBe(403);
    },
  );

  it('allows Sec-Fetch-Site: same-origin from loopback', async () => {
    const response = await requestLocal(app, url, { 'Sec-Fetch-Site': 'same-origin' });
    if (url === raw('a.md')) {
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('# hello');
      return;
    }
    expect(response.status).not.toBe(403);
  });
});
