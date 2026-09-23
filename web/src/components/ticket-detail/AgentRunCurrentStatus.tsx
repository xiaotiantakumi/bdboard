// bdboard-sso1.77: TicketAgentRunSection.tsx の「現在の実行状態・ログ・中止
// ボタン」ブロック (中身の div) を移動しただけの表示専用コンポーネント。
// JSX・className・aria属性・文言・DOM構造は移動前から変えていない。外側の
// 表示要否の条件式 (`polledRunDetail !== null || activeRunMeta !== null ||
// runStatusUnavailable`) は呼び出し元 (TicketAgentRunSection.tsx) にそのまま
// 残している — このコンポーネントは常にこの div を描画する。
import type { AgentRunDetailDto, AgentRunNextStepDto } from '../../api';
import { describeWriteError } from '../../writeAccessMessage';
import { isAgentRunInProgress } from '../agentRunShared';
import { AGENT_RUN_LOG_LOCAL_ONLY_HELP, formatAgentRunStatus } from './agentRun';
import { AgentRunNextStep } from './AgentRunNextStep';
import type { CopyDisplay, NextStepCopyTarget } from './types';

export interface AgentRunCurrentStatusProps {
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
}

export function AgentRunCurrentStatus({
  polledRunDetail,
  activeRunMeta,
  runStatusUnavailable,
  copyFeedback,
  onCopyNextStep,
  cancelRunMutation,
}: AgentRunCurrentStatusProps) {
  return (
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
  );
}
