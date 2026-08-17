import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { createCompressionMiddleware } from './compression.js';

describe('createCompressionMiddleware', () => {
  function createApp(): Hono {
    const app = new Hono();
    app.use('*', createCompressionMiddleware());
    app.get('/big', (c) => c.text('x'.repeat(2_000)));
    app.get('/api/events', (c) =>
      c.body('event-stream', 200, {
        'Content-Type': 'text/event-stream',
      }),
    );
    app.get('/not-modified', (c) => c.body(null, 304));
    return app;
  }

  it('gzip-compresses large bodies when Accept-Encoding allows gzip', async () => {
    const app = createApp();
    const response = await app.request('/big', {
      headers: { 'Accept-Encoding': 'gzip' },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Encoding')).toBe('gzip');
    expect(response.headers.get('Vary')).toContain('Accept-Encoding');
    const bytes = (await response.arrayBuffer()).byteLength;
    expect(bytes).toBeLessThan(2_000);
  });

  it('does not compress when client does not accept gzip', async () => {
    const app = createApp();
    const response = await app.request('/big');

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Encoding')).toBeNull();
    const text = await response.text();
    expect(text.length).toBe(2_000);
  });

  // hono/compress negotiates gzip *and* deflate, so deflate-only clients still
  // get a compressed body; only encodings it cannot produce fall back to identity.
  it('honours a deflate-only Accept-Encoding', async () => {
    const app = createApp();
    const response = await app.request('/big', {
      headers: { 'Accept-Encoding': 'deflate' },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Encoding')).toBe('deflate');
    expect((await response.arrayBuffer()).byteLength).toBeLessThan(2_000);
  });

  it('does not compress encodings hono cannot produce', async () => {
    const app = createApp();
    const response = await app.request('/big', {
      headers: { 'Accept-Encoding': 'br' },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Encoding')).toBeNull();
    expect(await response.text()).toHaveLength(2_000);
  });

  it('does not compress text/event-stream on /api/events', async () => {
    const app = createApp();
    const response = await app.request('/api/events', {
      headers: { 'Accept-Encoding': 'gzip' },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('text/event-stream');
    expect(response.headers.get('Content-Encoding')).toBeNull();
    expect(await response.text()).toBe('event-stream');
  });

  it('does not compress 304 responses', async () => {
    const app = createApp();
    const response = await app.request('/not-modified', {
      headers: { 'Accept-Encoding': 'gzip' },
    });

    expect(response.status).toBe(304);
    expect(response.headers.get('Content-Encoding')).toBeNull();
    expect(await response.text()).toBe('');
  });
});
