// bdboard-sso1.32: cli-chat-agent.ts を
// src/infrastructure/chat/cli-chat-agent/*.ts へモジュール分割した際の、型
// エクスポート面の回帰ガード。
//
// 値エクスポート (const/function) は cli-chat-agent.exportSurface.test.ts が
// `Object.keys()` で実行時に検証できるが、`export interface` は TypeScript の型のみの
// 宣言でコンパイルすると消える (実行時のバインディングを持たない) ため、Object.keys() には
// 現れずその手法では検証できない。代わりに、分割前の cli-chat-agent.ts の型
// エクスポート面 (6件: CliMcpServerSpec / CliTurnContext / CliTurnPlan / CliAuthProbe /
// CliChatAgentSpec / CliChatAgentDeps) を入口 (./cli-chat-agent.js) から import し、
// 1箇所の tuple 型で「使う」ことで `npm run build` (tsc --noEmit) に通す (dto.ts 分割,
// PR #540 / claude-runner.ts 分割, PR #580 と同じ方式)。
//
// 分割後の cli-chat-agent.ts はこれを re-export するだけの入口になる。ここが崩れる
// (型の移し忘れ・名前の変更・re-export の欠落) と、import 自体が解決できず tsc が
// このファイルで落ちる (TS2305: has no exported member)。
import type {
  CliAuthProbe,
  CliChatAgentDeps,
  CliChatAgentSpec,
  CliMcpServerSpec,
  CliTurnContext,
  CliTurnPlan,
} from './cli-chat-agent.js';

export type CliChatAgentTypeExportSurfaceCheck = [
  CliMcpServerSpec,
  CliTurnContext,
  CliTurnPlan,
  CliAuthProbe,
  CliChatAgentSpec,
  CliChatAgentDeps,
];
