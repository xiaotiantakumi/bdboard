import { Hono, type Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { ApiDeps } from './routes.js';

interface QueuedSseMessage {
  readonly event?: string;
  readonly data: string;
  /** SSE の `id:`。`notification` だけが持つ (bdboard-3tw.161)。 */
  readonly id?: string;
}

/**
 * 再接続時にどこから再送するかを決める id。ブラウザの自動再接続は `Last-Event-ID`
 * ヘッダーを送るのでそれを優先し、ページを開き直したときのように EventSource が
 * id を持っていない場合はクライアントが控えた id を `lastEventId` クエリで受け取る。
 */
function sseLastEventId(c: Context): string | undefined {
  const header = c.req.header('Last-Event-ID');
  if (header !== undefined && header !== '') {
    return header;
  }
  const query = c.req.query('lastEventId');
  return query !== undefined && query !== '' ? query : undefined;
}

function replayedNotificationData(data: unknown): string {
  if (typeof data === 'object' && data !== null && !Array.isArray(data)) {
    return JSON.stringify({ ...(data as Record<string, unknown>), replayed: true });
  }
  return JSON.stringify(data);
}

/** Max queued SSE messages per /api/events client before force-disconnect. */
const SSE_EVENTS_QUEUE_MAX_SIZE = 500;

function relayEventName(
  name: string,
): name is
  | 'board.changed'
  | 'session.changed'
  | 'notification' {
  return (
    name === 'board.changed' ||
    name === 'session.changed' ||
    name === 'notification'
  );
}

export function createRefreshEventsRoutes(deps: ApiDeps): Hono {
  const app = new Hono();

  app.post('/api/refresh', async (c) => {
    try {
      await deps.refresh();
      return c.json({ ok: true });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return c.json({ error: 'refresh failed', detail }, 500);
    }
  });

  app.get('/api/events', (c) => {
    const lastEventId = sseLastEventId(c);
    return streamSSE(c, async (stream) => {
      const queue: QueuedSseMessage[] = [];
      let wake: (() => void) | undefined;
      let cleanedUp = false;
      let clientGone = false;
      let pingTimer: ReturnType<typeof setInterval> | undefined;

      const waitForQueue = (): Promise<void> =>
        new Promise<void>((resolve) => {
          wake = resolve;
          if (queue.length > 0 || clientGone) {
            wake = undefined;
            resolve();
          }
        });

      const wakeUp = (): void => {
        const resume = wake;
        wake = undefined;
        resume?.();
      };

      const enqueue = (message: QueuedSseMessage): void => {
        if (clientGone) {
          return;
        }

        if (queue.length >= SSE_EVENTS_QUEUE_MAX_SIZE) {
          console.warn(
            `SSE /api/events: per-client queue limit (${SSE_EVENTS_QUEUE_MAX_SIZE}) reached; disconnecting slow client`,
          );
          cleanup();
          return;
        }

        queue.push(message);
        wakeUp();
      };

      // NOTE: Hono only bridges `c.req.raw.signal` to `stream.abort()` on old Bun
      // versions. On Node, `stream.onAbort` fires only when the response readable
      // is cancelled, so a client that aborts its request signal would otherwise
      // leak this subscription and the ping timer forever. Listen to both.
      const signal = c.req.raw.signal;

      const cleanup = (): void => {
        clientGone = true;
        wakeUp();

        if (cleanedUp) {
          return;
        }
        cleanedUp = true;
        unsubscribe();
        signal.removeEventListener('abort', cleanup);
        if (pingTimer !== undefined) {
          clearInterval(pingTimer);
          pingTimer = undefined;
        }
      };

      const unsubscribe = deps.events.subscribe((event) => {
        if (!relayEventName(event.name)) {
          return;
        }

        enqueue({
          event: event.name,
          data: JSON.stringify(event.data),
          ...(event.id !== undefined ? { id: event.id } : {}),
        });
      });

      // subscribe と同じ同期区間で取り出すので、取り出しと購読開始のあいだに publish が
      // 挟まって欠落・重複することは無い。hello の直後にライブ分より先に流れる。
      for (const replay of deps.events.notificationsSince(lastEventId)) {
        enqueue({
          event: replay.name,
          data: replayedNotificationData(replay.data),
          ...(replay.id !== undefined ? { id: replay.id } : {}),
        });
      }
      // 再送だけでキュー上限に達して切断済みなら、ping タイマー等を張らずに抜ける
      // (張ると cleanup 済みのため誰も止めない)。
      if (clientGone) {
        return;
      }

      stream.onAbort(() => {
        cleanup();
      });

      if (signal.aborted) {
        cleanup();
        return;
      }
      signal.addEventListener('abort', cleanup);

      pingTimer = setInterval(() => {
        enqueue({
          event: 'ping',
          data: JSON.stringify({ now: deps.now().toISOString() }),
        });
      }, 15_000);

      await stream.writeSSE({
        event: 'hello',
        data: JSON.stringify({ now: deps.now().toISOString() }),
      });

      try {
        while (!clientGone && !stream.aborted && !stream.closed) {
          while (!clientGone && queue.length > 0) {
            const message = queue.shift();
            if (message !== undefined) {
              await stream.writeSSE(message);
            }
          }

          if (clientGone || stream.aborted || stream.closed) {
            break;
          }

          await waitForQueue();
        }
      } finally {
        cleanup();
      }
    });
  });

  return app;
}
