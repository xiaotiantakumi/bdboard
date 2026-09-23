// bdboard-sso1.50: nextUpRunLoop.ts を ./next-up/run-loop/*.ts へモジュール分割した際の、
// 型エクスポート面の回帰ガード。
//
// 値エクスポート (function/const) は nextUpRunLoop.exportSurface.test.ts が
// `Object.keys()` で実行時に検証できるが、`export type` / `export interface` は
// TypeScript の型のみの宣言でコンパイルすると消える (実行時のバインディングを持たない)
// ため、Object.keys() には現れずその手法では検証できない。代わりに、分割前の main の
// nextUpRunLoop.ts から
// `grep -oE '^export (interface|type) [A-Za-z0-9_]+' web/src/components/nextUpRunLoop.ts`
// で機械的に採取した型エクスポート名を入口 (./nextUpRunLoop) からまとめて import し、
// 1箇所の tuple 型で「使う」ことで `npm run build:web` (tsc --noEmit) に通す
// (ps-process-scanner.ts 分割 #611 / ai-quota-source.ts 分割 #605 の方式)。
//
// 分割後の nextUpRunLoop.ts はサブモジュールへの再エクスポートのみになった。ここが
// 崩れる (型の移し忘れ・名前の変更・re-export の欠落) と、import 自体が解決できず tsc
// がこのファイルで落ちる (TS2305: has no exported member)。
import type {
  AgentRunTerminalOutcome,
  AgentRunTerminalResult,
  NextUpLoopEndReason,
  NextUpLoopPhase,
  NextUpLoopProgress,
  NextUpRunLoopController,
  NextUpRunLoopControllerOptions,
  TicketRunsChangedListener,
} from './nextUpRunLoop';

export type ExpectedTypeExportSurface = [
  NextUpLoopPhase,
  NextUpLoopEndReason,
  NextUpLoopProgress,
  TicketRunsChangedListener,
  NextUpRunLoopControllerOptions,
  NextUpRunLoopController,
  AgentRunTerminalOutcome,
  AgentRunTerminalResult,
];
