import { describe, expect, it, vi } from 'vitest';
import { createApiRoutes } from './routes.js';
import { createEventHub } from '../sse/event-hub.js';
import { NOW, LOCAL_ENV, withLocalHost, createDeps } from './routes-test-support.js';

const sseMockState = vi.hoisted(() => ({
  hangAfterHello: false,
}));

vi.mock('hono/streaming', async (importOriginal) => {
  const actual = await importOriginal<typeof import('hono/streaming')>();
  return {
    ...actual,
    streamSSE: (
      c: Parameters<typeof actual.streamSSE>[0],
      fn: Parameters<typeof actual.streamSSE>[1],
    ) =>
      actual.streamSSE(c, async (stream) => {
        const originalWriteSSE = stream.writeSSE.bind(stream);
        let pastHello = false;

        stream.writeSSE = async (message) => {
          if (sseMockState.hangAfterHello && pastHello) {
            await new Promise<void>(() => {});
          }

          const result = await originalWriteSSE(message);
          if (message.event === 'hello') {
            pastHello = true;
          }
          return result;
        };

        return fn(stream);
      }),
  };
});

// bdboard-sso1.7: routes.test.ts (createApiRoutes 総合テスト) を実装側のルート
// モジュール分割 (bdboard-sso1.1) に追随させてリソース別へ move-only 分割した一部。
// テスト本体・期待値・モックの記述は元の routes.test.ts から一字一句変更していない。
describe('createApiRoutes', () => {
  it('calls refresh handler on POST /api/refresh', async () => {
    const deps = createDeps();
    const app = createApiRoutes(deps);

    const response = await app.request(
      '/api/refresh',
      withLocalHost({ method: 'POST' }),
      LOCAL_ENV,
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(deps.refresh).toHaveBeenCalledTimes(1);
  });
  it('returns 500 when refresh fails', async () => {
    const deps = createDeps({
      refresh: vi.fn(async () => {
        throw new Error('refresh boom');
      }),
    });
    const app = createApiRoutes(deps);

    const response = await app.request(
      '/api/refresh',
      withLocalHost({ method: 'POST' }),
      LOCAL_ENV,
    );
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toEqual({ error: 'refresh failed', detail: 'refresh boom' });
  });
  it('subscribes during SSE and cleans up on abort', async () => {
    const events = createEventHub();
    const deps = createDeps({ events });
    const app = createApiRoutes(deps);

    expect(events.subscriberCount()).toBe(0);

    const controller = new AbortController();
    const requestPromise = app.request('/api/events', {
      signal: controller.signal,
    });

    await new Promise((resolve) => {
      setTimeout(resolve, 30);
    });

    expect(events.subscriberCount()).toBe(1);

    controller.abort();

    await Promise.resolve(requestPromise).catch(() => {});

    await new Promise((resolve) => {
      setTimeout(resolve, 30);
    });

    expect(events.subscriberCount()).toBe(0);
  });
  it('relays notification events over SSE', async () => {
    const events = createEventHub();
    const deps = createDeps({ events });
    const app = createApiRoutes(deps);

    const controller = new AbortController();
    const requestPromise = app.request('/api/events', {
      signal: controller.signal,
    });

    await new Promise((resolve) => {
      setTimeout(resolve, 30);
    });

    events.publish({
      name: 'notification',
      data: {
        kind: 'ticket_ready',
        ticketId: 'bdboard-ready',
        occurredAt: NOW.toISOString(),
      },
    });

    await new Promise((resolve) => {
      setTimeout(resolve, 30);
    });

    controller.abort();

    const response = await requestPromise;
    const bodyText = await response.text();

    expect(bodyText).toContain('event: notification');
    expect(bodyText).toContain('"kind":"ticket_ready"');
    expect(bodyText).toContain('"ticketId":"bdboard-ready"');
  });
  describe('notification replay on connect (bdboard-3tw.161)', () => {
    /*
     * 本文を少しずつ読み進める。abort してから response.text() で読むと、書き込みが
     * バックプレッシャーで止まったまま切断されるため hello と最初の1件しか届かず、
     * 順序や id の有無を確かめられない。
     */
    const openSse = async (
      app: ReturnType<typeof createApiRoutes>,
      path: string,
      headers: Record<string, string> = {},
    ) => {
      const controller = new AbortController();
      const response = await app.request(path, { signal: controller.signal, headers });
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let text = '';
      let pending: Promise<ReadableStreamReadResult<Uint8Array>> | null = null;

      return {
        async readUntil(done: (text: string) => boolean, timeoutMs = 2000): Promise<string> {
          const deadline = Date.now() + timeoutMs;
          while (!done(text) && Date.now() < deadline) {
            pending ??= reader.read();
            const result = await Promise.race([
              pending,
              new Promise<null>((resolve) => {
                setTimeout(() => resolve(null), 20);
              }),
            ]);
            if (result === null) {
              continue;
            }
            pending = null;
            if (result.done) {
              break;
            }
            text += decoder.decode(result.value, { stream: true });
          }
          return text;
        },
        async close(): Promise<void> {
          controller.abort();
          await reader.cancel().catch(() => {});
        },
      };
    };

    const sseBlocks = (text: string): string[] =>
      text.split('\n\n').filter((block) => block.trim() !== '');

    const ticketReady = (ticketId: string) => ({
      name: 'notification' as const,
      data: { kind: 'ticket_ready', ticketId, occurredAt: NOW.toISOString() },
    });

    it('replays a notification published while nobody was subscribed, after hello', async () => {
      const events = createEventHub({ epoch: 'boot' });
      const app = createApiRoutes(createDeps({ events }));

      events.publish(ticketReady('bdboard-missed'));
      expect(events.subscriberCount()).toBe(0);

      const sse = await openSse(app, '/api/events');
      const text = await sse.readUntil((t) => t.includes('bdboard-missed'));
      await sse.close();

      const blocks = sseBlocks(text);
      expect(blocks[0]).toContain('event: hello');
      expect(blocks[1]).toContain('event: notification');
      expect(blocks[1]).toContain('id: boot-1');
      expect(blocks[1]).toContain('"ticketId":"bdboard-missed"');
      expect(blocks[1]).toContain('"replayed":true');
    });

    it('streams replayed notifications oldest first, before live ones, and ids only on notifications', async () => {
      const events = createEventHub({ epoch: 'boot' });
      const app = createApiRoutes(createDeps({ events }));

      events.publish(ticketReady('bdboard-a'));
      events.publish(ticketReady('bdboard-b'));

      const sse = await openSse(app, '/api/events');
      await sse.readUntil((t) => t.includes('bdboard-b'));

      events.publish(ticketReady('bdboard-c'));
      events.publish({ name: 'board.changed', data: { reason: 'test' } });
      events.publish(ticketReady('bdboard-d'));

      const text = await sse.readUntil((t) => t.includes('bdboard-d'));
      await sse.close();

      const blocks = sseBlocks(text).filter((block) => !block.includes('event: ping'));
      expect(blocks.map((block) => block.match(/^event: (.+)$/m)?.[1])).toEqual([
        'hello',
        'notification',
        'notification',
        'notification',
        'board.changed',
        'notification',
      ]);
      expect(blocks.map((block) => block.match(/^id: (.+)$/m)?.[1] ?? null)).toEqual([
        null,
        'boot-1',
        'boot-2',
        'boot-3',
        null,
        'boot-4',
      ]);
      expect(blocks.map((block) => block.includes('"replayed":true'))).toEqual([
        false,
        true,
        true,
        false,
        false,
        false,
      ]);
      expect(blocks[1]).toContain('bdboard-a');
      expect(blocks[2]).toContain('bdboard-b');
      expect(blocks[3]).toContain('bdboard-c');
      expect(blocks[5]).toContain('bdboard-d');
    });

    it('replays only notifications newer than the Last-Event-ID header', async () => {
      const events = createEventHub({ epoch: 'boot' });
      const app = createApiRoutes(createDeps({ events }));

      events.publish(ticketReady('bdboard-seen'));
      events.publish(ticketReady('bdboard-new'));

      const sse = await openSse(app, '/api/events', { 'Last-Event-ID': 'boot-1' });
      const text = await sse.readUntil((t) => t.includes('bdboard-new'));
      await sse.close();

      expect(text).not.toContain('bdboard-seen');
      expect(text).toContain('id: boot-2');
    });

    it('accepts the last seen id via the lastEventId query parameter', async () => {
      const events = createEventHub({ epoch: 'boot' });
      const app = createApiRoutes(createDeps({ events }));

      events.publish(ticketReady('bdboard-seen'));
      events.publish(ticketReady('bdboard-new'));

      const sse = await openSse(app, '/api/events?lastEventId=boot-1');
      const text = await sse.readUntil((t) => t.includes('bdboard-new'));
      await sse.close();

      expect(text).not.toContain('bdboard-seen');
    });

    it('prefers the Last-Event-ID header over the query parameter', async () => {
      const events = createEventHub({ epoch: 'boot' });
      const app = createApiRoutes(createDeps({ events }));

      events.publish(ticketReady('bdboard-one'));
      events.publish(ticketReady('bdboard-two'));

      const sse = await openSse(app, '/api/events?lastEventId=boot-0', {
        'Last-Event-ID': 'boot-1',
      });
      const text = await sse.readUntil((t) => t.includes('bdboard-two'));
      await sse.close();

      expect(text).not.toContain('bdboard-one');
    });

    it('replays everything for an id from before a server restart', async () => {
      const events = createEventHub({ epoch: 'boot' });
      const app = createApiRoutes(createDeps({ events }));

      events.publish(ticketReady('bdboard-one'));
      events.publish(ticketReady('bdboard-two'));

      const sse = await openSse(app, '/api/events', { 'Last-Event-ID': 'previous-boot-9' });
      const text = await sse.readUntil((t) => t.includes('bdboard-two'));
      await sse.close();

      expect(text).toContain('bdboard-one');
    });

    it('delivers an AI quota threshold breach that happened while disconnected', async () => {
      const events = createEventHub({ epoch: 'boot' });
      const app = createApiRoutes(createDeps({ events }));

      events.publish({
        name: 'notification',
        data: {
          kind: 'ai_quota_threshold',
          providerId: 'codex',
          providerLabel: 'Codex',
          metricLabel: 'weekly',
          percentRemaining: 12,
          thresholdPercent: 20,
          occurredAt: NOW.toISOString(),
        },
      });

      const sse = await openSse(app, '/api/events');
      const text = await sse.readUntil((t) => t.includes('ai_quota_threshold'));
      await sse.close();

      expect(text).toContain('"kind":"ai_quota_threshold"');
      expect(text).toContain('"replayed":true');
    });
  });
  it('disconnects SSE when the per-client queue exceeds the limit', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      sseMockState.hangAfterHello = true;

      const events = createEventHub();
      const deps = createDeps({ events });
      const app = createApiRoutes(deps);

      expect(events.subscriberCount()).toBe(0);

      const requestPromise = app.request('/api/events', {}, LOCAL_ENV);

      await new Promise((resolve) => {
        setTimeout(resolve, 30);
      });

      expect(events.subscriberCount()).toBe(1);

      const boardChangedEvent = {
        name: 'board.changed' as const,
        data: { reason: 'queue-overflow-test' },
      };

      // hello 後の最初の dequeue で writeSSE がハングするため、queue には残り 500 件まで
      // 積める。501 件目の publish で queue.length === 500 となり、502 件目で上限切断する。
      for (let i = 0; i < 502; i++) {
        events.publish(boardChangedEvent);
      }

      await new Promise((resolve) => {
        setTimeout(resolve, 50);
      });

      expect(events.subscriberCount()).toBe(0);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('per-client queue limit'),
      );

      const response = await requestPromise;
      expect(response.status).toBe(200);
    } finally {
      sseMockState.hangAfterHello = false;
      warnSpy.mockRestore();
    }
  });
});
