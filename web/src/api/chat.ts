// web/src/api/chat.ts は bdboard-sso1.69 でモジュール分割された。実体は ./chat/ 配下:
//   - types.ts             : 公開型 (ChatAgentAvailability / ChatAvailabilityDto /
//     ChatAgentCapability / ChatModelDto / ChatAgentDto / ChatImageMimeType /
//     ChatImagePayload / ChatMessageRequest / ChatMessageResponseDto /
//     ChatSessionMessageDto / ChatSessionMessagesDto / ChatThreadDto / ChatTurnStatusDto /
//     DiscoveredChatSessionDto / DiscoveredChatSessionsDto / AdoptChatSessionResponseDto)
//   - threads.ts            : fetchChatAvailability / fetchChatAgents / fetchChatThreads /
//     fetchChatTurnStatus / acknowledgeChatTurn / deleteChatThread / updateChatThread
//   - message.ts            : postChatMessage
//   - stream.ts             : ChatStreamEndedWithoutResultError / postChatMessageStream
//   - session-messages.ts   : fetchChatSessionMessages
//   - discovery.ts          : fetchDiscoveredChatSessions / adoptDiscoveredChatSession
// このファイルは import 側 (呼び出し元・テスト) を書き換えないための入口としてのみ残す。
// 挙動・型は一切変えていない (移動のみ)。
export type {
  AdoptChatSessionResponseDto,
  ChatAgentAvailability,
  ChatAgentCapability,
  ChatAgentDto,
  ChatAvailabilityDto,
  ChatImageMimeType,
  ChatImagePayload,
  ChatMessageRequest,
  ChatMessageResponseDto,
  ChatModelDto,
  ChatSessionMessageDto,
  ChatSessionMessagesDto,
  ChatThreadDto,
  ChatTurnStatusDto,
  DiscoveredChatSessionDto,
  DiscoveredChatSessionsDto,
} from './chat/types';
export {
  acknowledgeChatTurn,
  deleteChatThread,
  fetchChatAgents,
  fetchChatAvailability,
  fetchChatThreads,
  fetchChatTurnStatus,
  updateChatThread,
} from './chat/threads';
export { postChatMessage } from './chat/message';
export { ChatStreamEndedWithoutResultError, postChatMessageStream } from './chat/stream';
export { fetchChatSessionMessages } from './chat/session-messages';
export { adoptDiscoveredChatSession, fetchDiscoveredChatSessions } from './chat/discovery';
