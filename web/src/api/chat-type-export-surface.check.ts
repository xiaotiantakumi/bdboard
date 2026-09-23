// bdboard-sso1.69: chat.ts を ./chat/*.ts へモジュール分割した際の、型エクスポート面の
// 回帰ガード。
//
// 値エクスポート (function/class) は chat.exportSurface.test.ts が `Object.keys()` で
// 実行時に検証できるが、`export type` / `export interface` は TypeScript の型のみの
// 宣言でコンパイルすると消える (実行時のバインディングを持たない) ため、Object.keys()
// には現れずその手法では検証できない。代わりに、分割前の main の chat.ts から
// `grep -oE '^export (interface|type) [A-Za-z0-9_]+' web/src/api/chat.ts` で機械的に
// 採取した型エクスポート名 (16件) を入口 (./chat) からまとめて import し、1箇所の
// tuple 型で「使う」ことで `npm run build:web` (tsc --noEmit) に通す
// (nextUpRunLoop.ts 分割 #614 / dto.ts 分割 #540 の方式)。
//
// 分割後の chat.ts はサブモジュールへの再エクスポートのみになった。ここが崩れる
// (型の移し忘れ・名前の変更・re-export の欠落) と、import 自体が解決できず tsc が
// このファイルで落ちる (TS2305: has no exported member)。
import type {
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
} from './chat';

export type ExpectedTypeExportSurface = [
  ChatAgentAvailability,
  ChatAvailabilityDto,
  ChatAgentCapability,
  ChatModelDto,
  ChatAgentDto,
  ChatImageMimeType,
  ChatImagePayload,
  ChatMessageRequest,
  ChatMessageResponseDto,
  ChatSessionMessageDto,
  ChatSessionMessagesDto,
  ChatThreadDto,
  ChatTurnStatusDto,
  DiscoveredChatSessionDto,
  DiscoveredChatSessionsDto,
  AdoptChatSessionResponseDto,
];
