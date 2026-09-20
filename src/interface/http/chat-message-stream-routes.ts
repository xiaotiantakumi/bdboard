// bdboard-sso1.17: chat-routes.ts (1015行) の分割で、POST
// /api/chat/message/stream (SSE ストリーミング送信) をここへ切り出した
// (move only, 挙動変更ゼロ)。ストリーミングの writer ループ (queue/abort/ping の
// クロージャ状態) は1リクエストあたり1回だけこのハンドラの中で作られる、常に
// ハンドラ内に閉じたローカル状態なので複製の懸念は無い。project 横断で共有する
// completedTurns/failedTurns の記録だけは chat-turn-tracker.ts の唯一の
// インスタンスを受け取って書き込む (所有者はそちらのまま)。

import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { ChatSessionStore } from '../../application/chat/chat-session-store.js';
import { finalizeChatTurnSuccess } from '../../application/chat/send-chat-message.js';
import { resolveChatStreamTurn } from '../../application/chat/send-chat-message-stream.js';
import type { BoardCache } from '../../application/ports/board-cache.js';
import type { ChatAgentRegistry } from '../../application/chat/chat-agent-registry.js';
import type { ChatMessageRepository } from '../../application/ports/chat-message-repository.js';
import { ChatAgentAbortedError, ChatAgentError } from '../../application/ports/chat-agent.js';
import type { WriteGuardDeps } from './write-guard.js';
import { decodeChatImages } from './chat-image-validation.js';
import { parseJsonBody } from './request-body.js';
import type { ChatTurnTracker } from './chat-turn-tracker.js';
import { messageBodySchema, toChatMessageResponseBody } from './chat-message-routes.js';

export interface ChatMessageStreamRoutesDeps {
  readonly cache: BoardCache;
  readonly agents: ChatAgentRegistry;
  readonly store: ChatSessionStore;
  readonly messages: ChatMessageRepository;
  readonly writeAccess?: WriteGuardDeps;
}

const CHAT_STREAM_PING_INTERVAL_MS = 15_000;
// Keep this aligned with /api/events' SSE_EVENTS_QUEUE_MAX_SIZE in routes.ts.
export const CHAT_STREAM_QUEUE_MAX_SIZE = 500;

interface QueuedSseMessage {
  readonly event: string;
  readonly data: string;
}

export function createChatMessageStreamRoutes(
  deps: ChatMessageStreamRoutesDeps,
  params: { readonly now: () => Date; readonly turnTracker: ChatTurnTracker },
): Hono {
  const app = new Hono();
  const { now, turnTracker } = params;

  app.post('/api/chat/message/stream', async (c) => {
    const parsed = await parseJsonBody(c, messageBodySchema);
    if (!parsed.ok) return parsed.response;
    const images = decodeChatImages(parsed.data.images);
    if (images === undefined && parsed.data.images !== undefined) {
      return c.json({ error: 'invalid request body' }, 400);
    }
    const sendInput = {
      projectId: parsed.data.projectId,
      message: parsed.data.message,
      ...(parsed.data.sessionId !== undefined ? { sessionId: parsed.data.sessionId } : {}),
      ...(parsed.data.agentId !== undefined ? { agentId: parsed.data.agentId } : {}),
      ...(parsed.data.model !== undefined ? { model: parsed.data.model } : {}),
      ...(images !== undefined && images.length > 0 ? { images } : {}),
    };
    const resolved = await resolveChatStreamTurn(deps, sendInput);
    if (!resolved.ok) {
      switch (resolved.failure.kind) {
        case 'project-not-found': return c.json({ error: 'project not found' }, 404);
        case 'invalid-message': return c.json({ error: 'invalid message', detail: resolved.failure.detail }, 400);
        case 'unknown-session': return c.json({ error: 'unknown chat session' }, 400);
        case 'unknown-agent': return c.json({ error: 'unknown chat agent', detail: resolved.failure.detail }, 400);
        case 'unknown-model': return c.json({ error: 'unknown chat model', detail: resolved.failure.detail }, 400);
        case 'agent-mismatch': return c.json({ error: 'chat agent mismatch', detail: resolved.failure.detail }, 400);
        case 'agent-unavailable': return c.json({ error: 'chat agent unavailable', detail: resolved.failure.detail }, 503);
        case 'busy': return c.json({ error: 'chat is busy for this project' }, 409);
        case 'streaming-not-supported': return c.json({ error: 'chat agent does not support streaming' }, 400);
        case 'image-not-supported': return c.json({ error: 'chat agent does not support image attachments' }, 400);
        case 'agent-error': return c.json({ error: 'chat failed', code: resolved.failure.code, detail: resolved.failure.detail }, 502);
      }
    }

    // 未回収の完了はここで消さない。以前は「新しいターンの完了が前のメタデータを
    // 置き換える」前提で1枠を消していたが、それだと別スレッドで送信しただけで
    // 先行スレッドの未回収返信が消え、二度と回収されなくなる (bdboard-3tw.155)。
    // 完了はキューに積み、クライアントの ACK でだけ落とす。

    // bdboard-l1t.9 Opus レビュー N6: リバースプロキシ(nginx等)が SSE をバッファ
    // リングして届かない/遅延することがあるための明示無効化。トンネル実機での
    // 実際のバースト到達確認は別チケット(議長側で起票)。
    c.header('X-Accel-Buffering', 'no');
    return streamSSE(c, async (stream) => {
      const queue: QueuedSseMessage[] = [];
      let wake: (() => void) | undefined;
      let clientGone = false;
      let cleanedUp = false;
      let finished = false;
      let pingTimer: ReturnType<typeof setInterval> | undefined;
      const signal = c.req.raw.signal;
      const waitForQueue = (): Promise<void> => new Promise((resolve) => {
        wake = resolve;
        if (queue.length > 0 || clientGone || finished) {
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
        if (clientGone) return;
        if (queue.length >= CHAT_STREAM_QUEUE_MAX_SIZE) {
          console.warn(
            `SSE /api/chat/message/stream: per-client queue limit (${CHAT_STREAM_QUEUE_MAX_SIZE}) reached; stopping delivery to slow client (turn continues)`,
          );
          queue.length = 0;
          // bdboard-rrvr: bdboard-3tw.165 (#482) added a best-effort 'detached' SSE
          // event here, issued just before cleanup/abort, so a client still actually
          // reading the stream could tell "delivery deliberately stopped" apart from an
          // ordinary abrupt disconnect. Removed: empirical testing against a real
          // node-server client over a paused TCP socket showed it is reliably dropped
          // for the actual slow/dead-connection case this feature exists for (it queues
          // directly behind an already-stalled write and is discarded with it once
          // abort() cancels the stream) — it could only ever reach a client in the
          // narrower case of a fast reader hitting a synchronous delta-burst overflow.
          // web never consumed it either way (only delta/done/error are handled).
          // GET /api/chat/turn-status (turnTracker.recordFailed below records this turn as
          // failed) remains the reliable signal a disconnected client actually relies
          // on to learn a turn failed; this removal does not touch that path.
          cleanup();
          stream.abort();
          return;
        }
        queue.push(message);
        wakeUp();
      };
      const cleanup = (): void => {
        // bdboard-7st added the browser-side fetch abort, but the old server cleanup
        // forwarded that abort to the CLI process and killed the actual AI turn.
        // A disconnect now stops SSE delivery only; runTurn deliberately receives no
        // request signal and continues through finalizeChatTurnSuccess for recovery.
        // Queue overflow uses this same path and aborts only the SSE writer.
        // onAbort() and the request signal can both arrive, so cleanup stays idempotent.
        if (cleanedUp) return;
        cleanedUp = true;
        clientGone = true;
        wakeUp();
        signal.removeEventListener('abort', cleanup);
        if (pingTimer !== undefined) {
          clearInterval(pingTimer);
          pingTimer = undefined;
        }
      };
      stream.onAbort(cleanup);
      if (signal.aborted) {
        cleanup();
      } else {
        signal.addEventListener('abort', cleanup);
      }

      pingTimer = setInterval(() => {
        enqueue({
          event: 'ping',
          data: JSON.stringify({ now: now().toISOString() }),
        });
      }, CHAT_STREAM_PING_INTERVAL_MS);

      const runTurn = async (): Promise<void> => {
        try {
          const turnResult = await resolved.handle.agent.sendMessageStream!(
            resolved.handle.turnRequest,
            (delta) => {
              if (!clientGone) {
                enqueue({ event: 'delta', data: JSON.stringify({ text: delta.text }) });
              }
            },
          );
          // finalize(store.remember + messages.append) is the durable boundary and must
          // run even after clientGone. Only SSE delivery is conditional on the subscriber;
          // the detached turn itself remains server-owned until this point.
          const success = finalizeChatTurnSuccess(deps, sendInput, turnResult);
          turnTracker.recordCompleted(parsed.data.projectId, {
            sessionId: success.sessionId,
            agentId: success.agentId,
            completedAt: now().toISOString(),
          });
          if (!clientGone) {
            enqueue({ event: 'done', data: JSON.stringify(toChatMessageResponseBody(success)) });
          }
        } catch (err) {
          if (err instanceof ChatAgentAbortedError) {
            console.debug('chat stream aborted');
          } else if (err instanceof ChatAgentError) {
            // bdboard-3tw.165: record the failure the same way finalizeChatTurnSuccess's
            // sibling turnTracker.recordCompleted does — unconditionally, not just when
            // clientGone. A connected client learns about this turn immediately via the
            // 'error' SSE event below and doesn't need to poll turn-status for it, but
            // recording it anyway keeps the two queues symmetric and is what lets a
            // *disconnected* client (whether via the queue-overflow detach above or an
            // ordinary drop) learn the turn failed from turn-status instead of inferring
            // it from an idle-without-completion transition.
            turnTracker.recordFailed(parsed.data.projectId, {
              ...(sendInput.sessionId !== undefined ? { sessionId: sendInput.sessionId } : {}),
              agentId: resolved.handle.agent.descriptor.id,
              code: err.code,
              failedAt: now().toISOString(),
            });
            if (!clientGone) {
              enqueue({ event: 'error', data: JSON.stringify({ error: 'chat failed', code: err.code, detail: err.detail }) });
            }
          } else {
            throw err;
          }
        } finally {
          // bdboard-pti0: release the per-project chat lock when the turn settles (after
          // finalize, before the writer can deliver 'done'), as bulk sendChatMessage does.
          // Tying it to the writer's exit let a stalled client below the queue limit hold
          // the lock forever. store.release is locks.delete(projectId): this must stay the
          // turn's only release, or a late writer exit would free the next turn's lock.
          resolved.handle.release();
        }
      };
      const turnPromise = runTurn().finally(() => {
        finished = true;
        wakeUp();
      });
      // bdboard-gwxz: the only other handler is the `await turnPromise` after the writer
      // loop. If runTurn rejects with a non-ChatAgentError (e.g. finalize throwing) while
      // the writer is stalled in writeSSE on a slow client, the rejection would sit
      // unhandled and Node's default --unhandled-rejections=throw could take the process
      // down. Mark it handled up front; the await below still rethrows to streamSSE.
      void turnPromise.catch(() => {});

      try {
        while (!clientGone && !stream.aborted && !stream.closed) {
          while (!clientGone && queue.length > 0) {
            const message = queue.shift();
            if (message !== undefined) await stream.writeSSE(message);
          }
          if (clientGone || stream.aborted || stream.closed || finished) break;
          await waitForQueue();
        }
        await turnPromise;
      } finally {
        // Lock release is owned by runTurn's settle path (bdboard-pti0), not here.
        cleanup();
      }
    });
  });

  return app;
}
