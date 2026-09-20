// bdboard-sso1.5: TicketDetailPanel.tsx からエージェント実行まわりの純粋ヘルパー
// を移動しただけのファイル。挙動は一切変えていない。
import type { AgentRunSummaryDto, TicketDetailDto } from '../../api';

export const AGENT_RUN_LOG_LOCAL_ONLY_HELP =
  'ログはこのPCのローカル画面からのみ表示できます。';

export function computeRunStartDisabled(
  ticket: TicketDetailDto,
  hasActiveRun: boolean,
  nowMs: number = Date.now(),
): { disabled: boolean; reason?: string } {
  if (ticket.status === 'closed') {
    return { disabled: true, reason: '完了済みのチケットは実行できません' };
  }
  if (
    (ticket.status === 'open' || ticket.status === 'pinned') &&
    ticket.blockedBy.length > 0
  ) {
    return { disabled: true, reason: 'ブロック中のチケットは実行できません' };
  }
  if (
    ticket.deferUntil !== undefined &&
    new Date(ticket.deferUntil).getTime() > nowMs
  ) {
    return { disabled: true, reason: '保留中のチケットは実行できません' };
  }
  if (hasActiveRun) {
    return { disabled: true };
  }
  return { disabled: false };
}

export const AGENT_RUN_NEXT_STEP_LABEL = '次に実行';

export function formatAgentRunStatus(status: AgentRunSummaryDto['status']): string {
  switch (status) {
    case 'pending':
      return '待機中';
    case 'running':
      return '実行中';
    case 'cancelling':
      return '中止中…';
    case 'succeeded':
      return '成功';
    case 'failed':
      return '失敗';
    case 'cancelled':
      return '中止';
  }
}
