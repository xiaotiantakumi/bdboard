// bdboard-sso1.77: TicketAgentRunSection.tsx の「実行履歴」一覧ブロックを
// 移動しただけの表示専用コンポーネント。JSX・className・aria属性・文言・
// DOM構造は移動前から変えていない。
import type { AgentRunSummaryDto } from '../../api';
import { formatAbsoluteTime } from '../../formatAbsoluteTime';
import { formatAgentRunStatus } from './agentRun';

export interface AgentRunHistoryListProps {
  ticketRunsLoading: boolean;
  ticketRunsError: unknown;
  ticketRunsData: { runs: AgentRunSummaryDto[] } | undefined;
  selectedHistoryRunId: string | null;
  onSelectHistoryRun: (runId: string) => void;
}

export function AgentRunHistoryList({
  ticketRunsLoading,
  ticketRunsError,
  ticketRunsData,
  selectedHistoryRunId,
  onSelectHistoryRun,
}: AgentRunHistoryListProps) {
  return (
    <>
      <h4 className="agent-run-history-heading">実行履歴</h4>
      {ticketRunsLoading && <p className="loading">読み込み中…</p>}
      {ticketRunsError !== null && (
        <p className="error-message">
          {ticketRunsError instanceof Error
            ? ticketRunsError.message
            : '実行履歴の読み込みに失敗しました'}
        </p>
      )}
      {ticketRunsData !== undefined &&
        ticketRunsData.runs.length === 0 && (
          <p className="detail-help">実行履歴はありません</p>
        )}
      {ticketRunsData !== undefined && ticketRunsData.runs.length > 0 && (
        <ul className="agent-run-history-list">
          {ticketRunsData.runs.map((run) => (
            <li key={run.id}>
              <button
                type="button"
                className={`agent-run-history-btn${
                  selectedHistoryRunId === run.id ? ' is-selected' : ''
                }`}
                onClick={() => onSelectHistoryRun(run.id)}
              >
                <time dateTime={run.startedAt}>
                  {formatAbsoluteTime(run.startedAt)}
                </time>
                <span className="agent-run-history-status">
                  {formatAgentRunStatus(run.status)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
