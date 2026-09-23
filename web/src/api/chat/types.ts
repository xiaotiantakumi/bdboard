import type { SessionTailMessageDto } from '../sessions';

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
