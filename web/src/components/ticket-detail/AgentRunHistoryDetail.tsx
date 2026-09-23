// bdboard-sso1.77: TicketAgentRunSection.tsx の「選択した実行履歴の詳細」
// ブロックを移動しただけの表示専用コンポーネント。JSX・className・aria属性・
// 文言・DOM構造は移動前から変えていない。
import type { AgentRunDetailDto, AgentRunNextStepDto } from '../../api';
import { AGENT_RUN_LOG_LOCAL_ONLY_HELP } from './agentRun';
import { AgentRunNextStep } from './AgentRunNextStep';
import type { CopyDisplay, NextStepCopyTarget } from './types';

export interface AgentRunHistoryDetailProps {
  selectedHistoryRunId: string | null;
  copyFeedback: CopyDisplay['feedback'];
  onCopyNextStep: (
    target: NextStepCopyTarget,
    nextStep: AgentRunNextStepDto,
  ) => void;
  selectedHistoryRunLoading: boolean;
  selectedHistoryRunError: unknown;
  selectedHistoryRun: AgentRunDetailDto | undefined;
}

export function AgentRunHistoryDetail({
  selectedHistoryRunId,
  copyFeedback,
  onCopyNextStep,
  selectedHistoryRunLoading,
  selectedHistoryRunError,
  selectedHistoryRun,
}: AgentRunHistoryDetailProps) {
  return (
    <>
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
    </>
  );
}
