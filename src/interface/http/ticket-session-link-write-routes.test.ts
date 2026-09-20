import { describe, expect, it, vi } from 'vitest';
import { createApiRoutes } from './routes.js';
import type { SessionLinkWriterPort } from '../../application/ports/session-link-writer.js';
import { BdError } from '../../application/ports/issue-repository.js';
import { LOCAL_ENV, withLocalHost, project, createFakeBoardCache, seedCache, createDeps } from './routes-test-support.js';

// bdboard-sso1.7: routes.test.ts (createApiRoutes 総合テスト) を実装側のルート
// モジュール分割 (bdboard-sso1.1) に追随させてリソース別へ move-only 分割した一部。
// テスト本体・期待値・モックの記述は元の routes.test.ts から一字一句変更していない。
describe('createApiRoutes', () => {
  describe('POST /api/tickets/:id/session-link', () => {
    it('returns 501 when session link writer is not configured', async () => {
      const app = createApiRoutes(createDeps());
      const response = await app.request(
        '/api/tickets/bdboard-a/session-link',
        withLocalHost({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId: 'sess-1' }),
        }),
        LOCAL_ENV,
      );
      const body = await response.json();

      expect(response.status).toBe(501);
      expect(body).toEqual({ error: 'session linking not available' });
    });

    it('links a session for a local request', async () => {
      const cache = createFakeBoardCache();
      seedCache(cache, [
        { project: project('proj-a', '/root/a'), ticketId: 'bdboard-a' },
      ]);

      const sessionLinkWriter: SessionLinkWriterPort = {
        linkSession: vi.fn(async () => {}),
        unlinkSession: vi.fn(async () => {}),
      };

      const app = createApiRoutes(createDeps({ cache, sessionLinkWriter }));
      const response = await app.request(
        '/api/tickets/bdboard-a/session-link',
        withLocalHost({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId: 'sess-1' }),
        }),
        LOCAL_ENV,
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toEqual({ ok: true });
      expect(sessionLinkWriter.linkSession).toHaveBeenCalledWith(
        '/root/a',
        'bdboard-a',
        'sess-1',
      );
    });

    it('returns 400 for an empty sessionId', async () => {
      const sessionLinkWriter: SessionLinkWriterPort = {
        linkSession: vi.fn(async () => {}),
        unlinkSession: vi.fn(async () => {}),
      };

      const app = createApiRoutes(createDeps({ sessionLinkWriter }));
      const response = await app.request(
        '/api/tickets/bdboard-a/session-link',
        withLocalHost({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId: '' }),
        }),
        LOCAL_ENV,
      );

      expect(response.status).toBe(400);
      expect(sessionLinkWriter.linkSession).not.toHaveBeenCalled();
    });

    it('returns 404 when the ticket is not found', async () => {
      const sessionLinkWriter: SessionLinkWriterPort = {
        linkSession: vi.fn(async () => {}),
        unlinkSession: vi.fn(async () => {}),
      };

      const app = createApiRoutes(createDeps({ sessionLinkWriter }));
      const response = await app.request(
        '/api/tickets/missing-ticket/session-link',
        withLocalHost({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId: 'sess-1' }),
        }),
        LOCAL_ENV,
      );

      expect(response.status).toBe(404);
      expect(sessionLinkWriter.linkSession).not.toHaveBeenCalled();
    });

    // Guards the isLocalControlRequest(c) gate at the top of the handler:
    // deleting that check would let this request through and call the writer.
    it('returns 403 for session-link POST through tunnel headers', async () => {
      const sessionLinkWriter: SessionLinkWriterPort = {
        linkSession: vi.fn(async () => {}),
        unlinkSession: vi.fn(async () => {}),
      };

      const app = createApiRoutes(createDeps({ sessionLinkWriter }));
      const response = await app.request(
        '/api/tickets/bdboard-a/session-link',
        withLocalHost({
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'CF-Ray': 'abc123',
          },
          body: JSON.stringify({ sessionId: 'sess-1' }),
        }),
        LOCAL_ENV,
      );
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body).toEqual({ error: 'local access only' });
      expect(sessionLinkWriter.linkSession).not.toHaveBeenCalled();
    });

    it('returns 502 with bd detail when linking fails', async () => {
      const cache = createFakeBoardCache();
      seedCache(cache, [
        { project: project('proj-a', '/root/a'), ticketId: 'bdboard-a' },
      ]);

      const sessionLinkWriter: SessionLinkWriterPort = {
        linkSession: vi.fn(async () => {
          throw new BdError('lock-contention', 'bdboard-a', 'database is locked');
        }),
        unlinkSession: vi.fn(async () => {}),
      };

      const app = createApiRoutes(createDeps({ cache, sessionLinkWriter }));
      const response = await app.request(
        '/api/tickets/bdboard-a/session-link',
        withLocalHost({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId: 'sess-1' }),
        }),
        LOCAL_ENV,
      );
      const body = await response.json();

      expect(response.status).toBe(502);
      expect(body).toEqual({
        error: 'failed to link session',
        detail: 'database is locked',
      });
    });
  });
  describe('DELETE /api/tickets/:id/session-link', () => {
    it('returns 501 when session link writer is not configured', async () => {
      const app = createApiRoutes(createDeps());
      const response = await app.request(
        '/api/tickets/bdboard-a/session-link',
        withLocalHost({ method: 'DELETE' }),
        LOCAL_ENV,
      );
      const body = await response.json();

      expect(response.status).toBe(501);
      expect(body).toEqual({ error: 'session linking not available' });
    });

    it('unlinks a session for a local request', async () => {
      const cache = createFakeBoardCache();
      seedCache(cache, [
        { project: project('proj-a', '/root/a'), ticketId: 'bdboard-a' },
      ]);

      const sessionLinkWriter: SessionLinkWriterPort = {
        linkSession: vi.fn(async () => {}),
        unlinkSession: vi.fn(async () => {}),
      };

      const app = createApiRoutes(createDeps({ cache, sessionLinkWriter }));
      const response = await app.request(
        '/api/tickets/bdboard-a/session-link',
        withLocalHost({ method: 'DELETE' }),
        LOCAL_ENV,
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toEqual({ ok: true });
      expect(sessionLinkWriter.unlinkSession).toHaveBeenCalledWith(
        '/root/a',
        'bdboard-a',
      );
    });

    it('returns 404 when the ticket is not found', async () => {
      const sessionLinkWriter: SessionLinkWriterPort = {
        linkSession: vi.fn(async () => {}),
        unlinkSession: vi.fn(async () => {}),
      };

      const app = createApiRoutes(createDeps({ sessionLinkWriter }));
      const response = await app.request(
        '/api/tickets/missing-ticket/session-link',
        withLocalHost({ method: 'DELETE' }),
        LOCAL_ENV,
      );

      expect(response.status).toBe(404);
      expect(sessionLinkWriter.unlinkSession).not.toHaveBeenCalled();
    });

    // Guards the isLocalControlRequest(c) gate at the top of the handler:
    // deleting that check would let this request through and call the writer.
    it('returns 403 for session-link DELETE through tunnel headers', async () => {
      const sessionLinkWriter: SessionLinkWriterPort = {
        linkSession: vi.fn(async () => {}),
        unlinkSession: vi.fn(async () => {}),
      };

      const app = createApiRoutes(createDeps({ sessionLinkWriter }));
      const response = await app.request(
        '/api/tickets/bdboard-a/session-link',
        withLocalHost({
          method: 'DELETE',
          headers: { 'CF-Ray': 'abc123' },
        }),
        LOCAL_ENV,
      );
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body).toEqual({ error: 'local access only' });
      expect(sessionLinkWriter.unlinkSession).not.toHaveBeenCalled();
    });

    it('returns 502 with bd detail when unlinking fails', async () => {
      const cache = createFakeBoardCache();
      seedCache(cache, [
        { project: project('proj-a', '/root/a'), ticketId: 'bdboard-a' },
      ]);

      const sessionLinkWriter: SessionLinkWriterPort = {
        linkSession: vi.fn(async () => {}),
        unlinkSession: vi.fn(async () => {
          throw new BdError('unknown', 'bdboard-a', 'something went wrong');
        }),
      };

      const app = createApiRoutes(createDeps({ cache, sessionLinkWriter }));
      const response = await app.request(
        '/api/tickets/bdboard-a/session-link',
        withLocalHost({ method: 'DELETE' }),
        LOCAL_ENV,
      );
      const body = await response.json();

      expect(response.status).toBe(502);
      expect(body).toEqual({
        error: 'failed to unlink session',
        detail: 'something went wrong',
      });
    });
  });
});
