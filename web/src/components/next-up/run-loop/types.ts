export type NextUpLoopPhase = 'idle' | 'running' | 'stopping';

export type NextUpLoopEndReason =
  | 'completed'
  | 'stopped'
  | 'poll_failed'
  | 'consecutive_failures';

export interface NextUpLoopProgress {
  currentTicketId: string | null;
  completedCount: number;
  failedCount: number;
  cancelledCount: number;
  unknownCount: number;
  totalCount: number;
  lastFailureReason: string | null;
  endReason: NextUpLoopEndReason | null;
}

/**
 * ループが開始・終了させた実行を、ループの外にある実行履歴 (詳細パネルの ticket-runs) へ
 * 知らせるための通知。詳細パネルは自分で開始した実行しか追跡しないので、ループ由来の
 * 実行は通知が無いと再マウント・フォーカスまで履歴に出ない (bdboard-3tw.163)。
 */
export type TicketRunsChangedListener = (ticketId: string) => void;

export interface NextUpRunLoopControllerOptions {
  onTicketRunsChanged?: TicketRunsChangedListener;
}

export interface NextUpRunLoopController {
  phase: NextUpLoopPhase;
  progress: NextUpLoopProgress;
  beginBatchRun: (ticketIds: readonly string[]) => void;
  stopBatchRun: () => void;
}

export type AgentRunTerminalOutcome =
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'poll_failed'
  | 'stopped';

export interface AgentRunTerminalResult {
  outcome: AgentRunTerminalOutcome;
  lastPollError?: unknown;
}
