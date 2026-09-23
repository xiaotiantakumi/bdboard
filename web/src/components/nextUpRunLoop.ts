// web/src/components/nextUpRunLoop.ts は bdboard-sso1.50 でモジュール分割された。
// 実体は ./next-up/run-loop/ 配下:
//   - types.ts                 : 公開型 (NextUpLoopPhase / NextUpLoopEndReason /
//     NextUpLoopProgress / TicketRunsChangedListener / NextUpRunLoopControllerOptions /
//     NextUpRunLoopController / AgentRunTerminalOutcome / AgentRunTerminalResult)
//   - progress.ts               : INITIAL_NEXT_UP_LOOP_PROGRESS
//   - ticketRunsInvalidator.ts  : createTicketRunsInvalidator
//   - failureMessages.ts        : 連続失敗の上限・停止コメント関連
//     (NEXT_UP_LOOP_MAX_CONSECUTIVE_FAILURES / NEXT_UP_LOOP_COMMENT_POST_TIMEOUT_MS /
//     describeConsecutiveFailureStop / buildConsecutiveFailureComment)
//   - polling.ts                : 実行状況ポーリング
//     (NEXT_UP_LOOP_POLL_MAX_FAILURES / NEXT_UP_LOOP_POLL_MAX_DELAY_MS /
//     nextUpLoopPollDelayMs / describePollFailureError / isAgentRunTerminal /
//     waitForAgentRunTerminal)
//   - loop.ts                   : runNextUpTicketLoop 本体
//   - controller.ts             : useNextUpRunLoopController (React フック)
// このファイルは import 側 (呼び出し元・テスト) を書き換えないための入口としてのみ残す。
// 挙動・型は一切変えていない (移動のみ)。
export type {
  AgentRunTerminalOutcome,
  AgentRunTerminalResult,
  NextUpLoopEndReason,
  NextUpLoopPhase,
  NextUpLoopProgress,
  NextUpRunLoopController,
  NextUpRunLoopControllerOptions,
  TicketRunsChangedListener,
} from './next-up/run-loop/types';
export { INITIAL_NEXT_UP_LOOP_PROGRESS } from './next-up/run-loop/progress';
export { createTicketRunsInvalidator } from './next-up/run-loop/ticketRunsInvalidator';
export {
  NEXT_UP_LOOP_COMMENT_POST_TIMEOUT_MS,
  NEXT_UP_LOOP_MAX_CONSECUTIVE_FAILURES,
  buildConsecutiveFailureComment,
  describeConsecutiveFailureStop,
} from './next-up/run-loop/failureMessages';
export {
  NEXT_UP_LOOP_POLL_MAX_DELAY_MS,
  NEXT_UP_LOOP_POLL_MAX_FAILURES,
  describePollFailureError,
  isAgentRunTerminal,
  nextUpLoopPollDelayMs,
  waitForAgentRunTerminal,
} from './next-up/run-loop/polling';
export { runNextUpTicketLoop } from './next-up/run-loop/loop';
export { useNextUpRunLoopController } from './next-up/run-loop/controller';
