import type { SessionTailMessageDto } from './sessions';
import { ApiError, fetchJson, readErrorPayload } from './http';

/** src/application/ports/chat-agent.ts の ChatAgentAvailability と同形の二重定義。 */
export type ChatAgentAvailability = 'available' | 'unknown' | 'unavailable';

export interface ChatAvailabilityDto {
  availability: ChatAgentAvailability;
}

/**
 * src/interface/http/dto.ts の ChatAgentDto と同形の二重定義。
 * web から src への import は依存境界で禁止されているので、意図的に重複させている。
 */
export type ChatAgentCapability = 'bd-only' | 'reads-project' | 'unrestricted';

export interface ChatModelDto {
  id: string;
  label: string;
}

export interface ChatAgentDto {
  id: string;
  label: string;
  model?: string;
  models?: ChatModelDto[];
  experimental: boolean;
  capability: ChatAgentCapability;
  availability: ChatAgentAvailability;
  supportsStreaming: boolean;
  supportsImages: boolean;
}

export type ChatImageMimeType = 'image/png' | 'image/jpeg' | 'image/webp';

export interface ChatImagePayload {
  mimeType: ChatImageMimeType;
  /** data URL prefix を含まない base64 本体。 */
  data: string;
}

export interface ChatMessageRequest {
  projectId: string;
  message: string;
  sessionId?: string;
  agentId?: string;
  model?: string;
  images?: ChatImagePayload[];
}

export interface ChatMessageResponseDto {
  reply: string;
  sessionId: string;
  agentId: string;
  model?: string;
  /** 今回のターンで実行できなかった bd ツール呼び出しの名前。無ければ省略される。 */
  failedTools?: string[];
  /** ターンは成功したが運用者に知らせるべきエージェント側の警告。無ければ省略される。 */
  agentWarnings?: string[];
}

export interface ChatSessionMessageDto {
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
  failedTools?: string[];
  agentWarnings?: string[];
}

export interface ChatSessionMessagesDto {
  sessionId: string;
  agentId: string;
  model?: string;
  messages: ChatSessionMessageDto[];
}

export interface ChatThreadDto {
  sessionId: string;
  agentId: string;
  title: string | null;
  pinned: boolean;
  updatedAt: string;
}

export type ChatTurnStatusDto =
  | { state: 'idle' }
  | {
      state: 'processing';
      sessionId?: string;
      agentId?: string;
      message?: string;
    }
  | {
      state: 'completed';
      sessionId: string;
      agentId: string;
      completedAt: string;
    }
  | {
      // bdboard-3tw.165: explicit failure state, so a completed-turn recovery flow can
      // stop inferring a failed turn from turn-status going idle without ever passing
      // through 'completed'. sessionId is absent when the turn failed before the agent
      // ever assigned one (a brand-new thread).
      state: 'failed';
      code: string;
      sessionId?: string;
      agentId: string;
      failedAt: string;
    };

export interface DiscoveredChatSessionDto {
  sessionId: string;
  lastActivityAt: string;
  alreadyAdopted: boolean;
  firstMessagePreview?: string;
  lastMessagePreview?: string;
}

export interface DiscoveredChatSessionsDto {
  sessions: DiscoveredChatSessionDto[];
}

export interface AdoptChatSessionResponseDto {
  sessionId: string;
  agentId: string;
  /**
   * adopt 直後にチャット履歴をシードするための、トランスクリプト末尾の会話
   * (bdboard-3tw.104.3 レビュー M1)。discovery が local-only ガード配下で既に読んだ
   * トランスクリプトから返るので、別途 `/api/sessions/:id/tail` を叩き直す必要はない。
   */
  seedMessages: SessionTailMessageDto[];
}

export function fetchChatAvailability(): Promise<ChatAvailabilityDto> {
  return fetchJson<ChatAvailabilityDto>('/api/chat/availability');
}

export function fetchChatAgents(): Promise<ChatAgentDto[]> {
  return fetchJson<ChatAgentDto[]>('/api/chat/agents');
}

export function fetchChatThreads(projectId: string): Promise<ChatThreadDto[]> {
  const params = new URLSearchParams({ projectId });
  return fetchJson<ChatThreadDto[]>(`/api/chat/threads?${params.toString()}`);
}

export function fetchChatTurnStatus(projectId: string): Promise<ChatTurnStatusDto> {
  const params = new URLSearchParams({ projectId });
  return fetchJson<ChatTurnStatusDto>(
    `/api/chat/turn-status?${params.toString()}`,
  );
}

export function acknowledgeChatTurn(projectId: string, sessionId: string): Promise<void> {
  const params = new URLSearchParams({ projectId, sessionId });
  return fetchJson<void>(`/api/chat/turn-status?${params.toString()}`, {
    method: 'DELETE',
  });
}

export function deleteChatThread(sessionId: string, projectId: string): Promise<void> {
  const params = new URLSearchParams({ projectId });
  return fetchJson<void>(
    `/api/chat/sessions/${encodeURIComponent(sessionId)}?${params.toString()}`,
    { method: 'DELETE' },
  );
}

export function updateChatThread(
  sessionId: string,
  projectId: string,
  patch: { title?: string | null; pinned?: boolean },
): Promise<ChatThreadDto> {
  return fetchJson<ChatThreadDto>(
    `/api/chat/sessions/${encodeURIComponent(sessionId)}/thread`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId, ...patch }),
    },
  );
}

export function postChatMessage(
  body: ChatMessageRequest,
  signal?: AbortSignal,
): Promise<ChatMessageResponseDto> {
  const payload: ChatMessageRequest = {
    projectId: body.projectId,
    message: body.message,
  };
  if (body.sessionId !== undefined) {
    payload.sessionId = body.sessionId;
  }
  if (body.agentId !== undefined) {
    payload.agentId = body.agentId;
  }
  if (body.model !== undefined) {
    payload.model = body.model;
  }
  if (body.images !== undefined) {
    payload.images = body.images;
  }
  return fetchJson<ChatMessageResponseDto>('/api/chat/message', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    ...(signal !== undefined ? { signal } : {}),
  });
}

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

export function fetchChatSessionMessages(
  sessionId: string,
  projectId: string,
): Promise<ChatSessionMessagesDto> {
  const params = new URLSearchParams({ projectId });
  return fetchJson<ChatSessionMessagesDto>(
    `/api/chat/sessions/${encodeURIComponent(sessionId)}/messages?${params.toString()}`,
  );
}

export function fetchDiscoveredChatSessions(
  projectId: string,
): Promise<DiscoveredChatSessionsDto> {
  return fetchJson<DiscoveredChatSessionsDto>(
    `/api/chat/projects/${encodeURIComponent(projectId)}/discovered-sessions`,
  );
}

export function adoptDiscoveredChatSession(
  projectId: string,
  sessionId: string,
  agentId?: string,
): Promise<AdoptChatSessionResponseDto> {
  return fetchJson<AdoptChatSessionResponseDto>(
    `/api/chat/projects/${encodeURIComponent(projectId)}/discovered-sessions/${encodeURIComponent(sessionId)}/adopt`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(agentId !== undefined ? { agentId } : {}),
    },
  );
}
