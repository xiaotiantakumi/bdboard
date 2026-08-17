import { compress } from 'hono/compress';
import type { MiddlewareHandler } from 'hono';

const SSE_PATH = '/api/events';

/**
 * gzip via hono/compress (measured working on Node 22 + @hono/node-server:
 * ~639KB /api/board -> ~16KB). Do not add a zlib fallback — it buffers every
 * uncompressed response via arrayBuffer().
 */
export function createCompressionMiddleware(): MiddlewareHandler {
  const inner = compress();

  return async (c, next) => {
    // Defense in depth: hono already skips text/event-stream, but keep this
    // guard in case the SSE route's content type ever changes.
    if (c.req.path === SSE_PATH) {
      await next();
      return;
    }

    return inner(c, next);
  };
}
