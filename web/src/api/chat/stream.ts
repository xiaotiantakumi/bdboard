import { ApiError, readErrorPayload } from '../http';
import type { ChatMessageRequest, ChatMessageResponseDto } from './types';

/**
 * `done` / `error` のどちらも受け取らないままチャットストリームが正常終了したことを表す。
 * サーバーは SSE キュー上限超過 (CHAT_STREAM_QUEUE_MAX_SIZE, bdboard-zyr3) などで配信
 * だけを止めることがあり、その場合もターン自体はサーバー側で完走・保存され、
 * /api/chat/turn-status から回収できる。呼び出し側はメッセージ文字列ではなく
 * この型で判別し、送信失敗ではなくターン回収経路へ流す (bdboard-zlzo)。
 */
export class ChatStreamEndedWithoutResultError extends Error {
  constructor() {
    super('chat stream ended unexpectedly');
    this.name = 'ChatStreamEndedWithoutResultError';
  }
}

export function postChatMessageStream(
  body: ChatMessageRequest,
  callbacks: { onDelta: (text: string) => void },
  signal?: AbortSignal,
): Promise<ChatMessageResponseDto> {
  const payload: typeof body = { projectId: body.projectId, message: body.message };
  if (body.sessionId !== undefined) payload.sessionId = body.sessionId;
  if (body.agentId !== undefined) payload.agentId = body.agentId;
  if (body.model !== undefined) payload.model = body.model;
  if (body.images !== undefined) payload.images = body.images;

  return (async () => {
    const res = await fetch('/api/chat/message/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      ...(signal !== undefined ? { signal } : {}),
    });
    if (!res.ok) {
      const { body: errorBody, errorMessage, detail, code, details } = await readErrorPayload(res);
      throw new ApiError(
        res.status,
        errorMessage ?? `HTTP ${res.status} ${res.statusText}: /api/chat/message/stream`,
        { body: errorBody, errorMessage, detail, code, details },
      );
    }
    if (res.body === null) throw new Error('no response body');

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let result: ChatMessageResponseDto | undefined;
    const processEvent = (eventBlock: string) => {
      let eventName: string | undefined;
      // bdboard-l1t.9 Opus レビュー N4: SSE の仕様上、1イベントに複数の `data:` 行が
      // あれば改行で連結するのが正しい(上書きではない)。このサーバー実装は
      // 常に1行しか出さないが、仕様通りに実装しておく。
      const dataLines: string[] = [];
      for (const line of eventBlock.split('\n')) {
        if (line.startsWith('event:')) eventName = line.slice(6).trim();
        if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
      }
      if (dataLines.length === 0) return;
      const data = dataLines.join('\n');
      if (eventName === 'delta') {
        callbacks.onDelta((JSON.parse(data) as { text: string }).text);
      } else if (eventName === 'done') {
        result = JSON.parse(data) as ChatMessageResponseDto;
      } else if (eventName === 'error') {
        const parsed = JSON.parse(data) as { error: string; code?: string; detail?: string };
        throw new ApiError(502, parsed.error, {
          errorMessage: parsed.error,
          code: parsed.code,
          detail: parsed.detail,
        });
      }
    };

    try {
      while (result === undefined) {
        const { value, done } = await reader.read();
        if (done) {
          buffer += decoder.decode();
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split('\n\n');
        buffer = events.pop() ?? '';
        for (const event of events) {
          processEvent(event);
          if (result !== undefined) break;
        }
      }
    } finally {
      // bdboard-l1t.9 Opus レビュー S4: error throw 時・done 到達後の break 時に
      // reader を握ったままにしない。reader.cancel() はサーバー側の
      // c.req.raw.signal 'abort' にも波及し、まだ動いている子プロセスの
      // 停止にもつながる副次効果がある。
      reader.cancel().catch(() => {});
    }
    if (result === undefined) throw new ChatStreamEndedWithoutResultError();
    return result;
  })();
}
