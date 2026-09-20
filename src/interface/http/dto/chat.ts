// bdboard-sso1.12: dto.ts のモジュール分割。チャットエージェント記述子の DTO。
// chat-routes.ts が参照する (barrel 経由)。セッション発見系 (DiscoveredChatSessionDto)
// は session.ts 側。
import type {
  ChatAgentAvailability,
  ChatAgentCapability,
  ChatAgentDescriptor,
} from '../../../application/ports/chat-agent.js';

export interface ChatAgentDto {
  id: string;
  label: string;
  model?: string;
  models?: { id: string; label: string }[];
  experimental: boolean;
  supportsStreaming: boolean;
  supportsImages: boolean;
  capability: ChatAgentCapability;
  availability: ChatAgentAvailability;
}

export function toChatAgentDto(
  descriptor: ChatAgentDescriptor,
  availability: ChatAgentAvailability,
): ChatAgentDto {
  return {
    id: descriptor.id,
    label: descriptor.label,
    ...(descriptor.model !== undefined ? { model: descriptor.model } : {}),
    ...(descriptor.models !== undefined
      ? {
          models: descriptor.models.map((entry) => ({
            id: entry.id,
            label: entry.label,
          })),
        }
      : {}),
    experimental: descriptor.experimental,
    supportsStreaming: descriptor.supportsStreaming ?? false,
    supportsImages: descriptor.supportsImages ?? false,
    capability: descriptor.capability,
    availability,
  };
}
