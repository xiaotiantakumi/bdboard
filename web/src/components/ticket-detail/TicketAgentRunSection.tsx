// bdboard-sso1.5 (PR-L): TicketDetailPanel.tsx の「エージェント実行」表示
// セクション (現在の実行状態・ログ・中止ボタン・実行履歴一覧・選択した履歴の
// 詳細) を移動しただけの表示専用コンポーネント。state・query・mutation は
// useTicketAgentRun (親で呼び出し) に残し、値とハンドラを props で受け取る。
// JSX・className・aria属性・文言・DOM構造は移動前から変えていない。
//
// 「次に実行」コマンドのコピー (copyFeedback / onCopyNextStep) は bd コマンド
// コピーと状態を共有する (useAutoClearedValue, bdboard-ty72) ので、親からその
// まま props で受け取る — このコンポーネント/useTicketAgentRun のどちらにも
// 持たせない。
import type {
  AgentRunDetailDto,
  AgentRunNextStepDto,
  AgentRunSummaryDto,
} from '../../api';
import { formatAbsoluteTime } from '../../formatAbsoluteTime';
import { describeWriteError } from '../../writeAccessMessage';
import { isAgentRunInProgress } from '../agentRunShared';
import {
  AGENT_RUN_LOG_LOCAL_ONLY_HELP,
  formatAgentRunStatus,
} from './agentRun';
import { AgentRunNextStep } from './AgentRunNextStep';
import type { CopyDisplay, NextStepCopyTarget } from './types';

export interface TicketAgentRunSectionProps {
  polledRunDetail: AgentRunDetailDto | null;
  activeRunMeta: {
    worktreePath: string;
    branchName: string;
    reused: boolean;
  } | null;
  runStatusUnavailable: boolean;
  copyFeedback: CopyDisplay['feedback'];
  onCopyNextStep: (
    target: NextStepCopyTarget,
    nextStep: AgentRunNextStepDto,
  ) => void;
  cancelRunMutation: {
    isPending: boolean;
    error: unknown;
    mutate: () => void;
  };
  ticketRunsLoading: boolean;
  ticketRunsError: unknown;
  ticketRunsData: { runs: AgentRunSummaryDto[] } | undefined;
  selectedHistoryRunId: string | null;
  onSelectHistoryRun: (runId: string) => void;
  selectedHistoryRunLoading: boolean;
  selectedHistoryRunError: unknown;
  selectedHistoryRun: AgentRunDetailDto | undefined;
}

export function TicketAgentRunSection({
  polledRunDetail,
  activeRunMeta,
  runStatusUnavailable,
  copyFeedback,
  onCopyNextStep,
  cancelRunMutation,
  ticketRunsLoading,
  ticketRunsError,
  ticketRunsData,
  selectedHistoryRunId,
  onSelectHistoryRun,
  selectedHistoryRunLoading,
  selectedHistoryRunError,
  selectedHistoryRun,
}: TicketAgentRunSectionProps) {
  return (
    <div className="detail-section">
      <h3>エージェント実行</h3>
      {(polledRunDetail !== null ||
        activeRunMeta !== null ||
        runStatusUnavailable) && (
        <div className="agent-run-current">
          {runStatusUnavailable && (
            <p className="agent-run-status agent-run-status-unavailable">
              状態を取得できません（実行状況の取得に失敗したため監視を停止しました）
            </p>
          )}
          {polledRunDetail !== null && (
            <p className="agent-run-status">
              状態: {formatAgentRunStatus(polledRunDetail.status)}
              {polledRunDetail.exitCode !== undefined &&
                ` (終了コード: ${polledRunDetail.exitCode})`}
              {polledRunDetail.error !== undefined &&
                ` — ${polledRunDetail.error}`}
            </p>
          )}
          {(activeRunMeta !== null || polledRunDetail !== null) && (
            <dl className="agent-run-meta">
              <div>
                <dt>worktree</dt>
                <dd>
                  {polledRunDetail?.cwd ??
                    activeRunMeta?.worktreePath ??
                    '—'}
                </dd>
              </div>
              {activeRunMeta !== null && (
                <div>
                  <dt>branch</dt>
                  <dd>{activeRunMeta.branchName}</dd>
                </div>
              )}
              {activeRunMeta !== null && (
                <div>
                  <dt>worktree の扱い</dt>
                  <dd>
                    {activeRunMeta.reused ? '既存を再利用' : '新規作成'}
                  </dd>
                </div>
              )}
            </dl>
          )}
          {polledRunDetail?.nextStep !== undefined && (
            <AgentRunNextStep
              nextStep={polledRunDetail.nextStep}
              target="next-step-current"
              copied={
                copyFeedback?.kind === 'success' &&
                copyFeedback.command === 'next-step-current'
              }
              onCopy={(target, nextStep) => onCopyNextStep(target, nextStep)}
            />
          )}
          {polledRunDetail !== null &&
            isAgentRunInProgress(polledRunDetail.status) && (
              <button
                type="button"
                className="btn btn-small agent-run-cancel-btn"
                disabled={
                  cancelRunMutation.isPending ||
                  polledRunDetail.status === 'cancelling'
                }
                onClick={() => cancelRunMutation.mutate()}
              >
                {cancelRunMutation.isPending ||
                polledRunDetail.status === 'cancelling'
                  ? '中止中…'
                  : '中止'}
              </button>
            )}
          {cancelRunMutation.error !== null && (
            <p className="error-message">
              {describeWriteError(
                cancelRunMutation.error,
                'エージェントの実行を中止できませんでした',
              )}
            </p>
          )}
          {polledRunDetail !== null &&
            polledRunDetail.logRestricted === true && (
              <p className="detail-help">{AGENT_RUN_LOG_LOCAL_ONLY_HELP}</p>
            )}
          {polledRunDetail !== null &&
            polledRunDetail.logRestricted !== true &&
            polledRunDetail.log.length > 0 && (
              <details className="agent-run-log-details">
                <summary>実行ログ</summary>
                <pre className="agent-run-log-pre">{polledRunDetail.log}</pre>
              </details>
            )}
        </div>
      )}
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
      {selectedHistoryRunId !== null && selectedHistoryRunLoading && (
        <p className="loading">ログを読み込み中…</p>
      )}
      {selectedHistoryRunError !== null && (
        <p className="error-message">
          {selectedHistoryRunError instanceof Error
            ? selectedHistoryRunError.message
            : '実行ログの読み込みに失敗しました'}
        </p>
      )}
      {selectedHistoryRun !== undefined && (
        <div className="agent-run-history-detail">
          <dl className="agent-run-meta">
            <div>
              <dt>worktree</dt>
              <dd>{selectedHistoryRun.cwd ?? '—'}</dd>
            </div>
          </dl>
          {selectedHistoryRun.nextStep !== undefined && (
            <AgentRunNextStep
              nextStep={selectedHistoryRun.nextStep}
              target="next-step-history"
              copied={
                copyFeedback?.kind === 'success' &&
                copyFeedback.command === 'next-step-history'
              }
              onCopy={(target, nextStep) => onCopyNextStep(target, nextStep)}
            />
          )}
          <details className="agent-run-log-details" open>
            <summary>実行ログ</summary>
            {selectedHistoryRun.logRestricted === true ? (
              <p className="detail-help">{AGENT_RUN_LOG_LOCAL_ONLY_HELP}</p>
            ) : (
              <pre className="agent-run-log-pre">
                {selectedHistoryRun.log.length > 0
                  ? selectedHistoryRun.log
                  : '(ログなし)'}
              </pre>
            )}
          </details>
        </div>
      )}
    </div>
  );
}
