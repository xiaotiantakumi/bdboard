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
//
// bdboard-sso1.77: 「現在の状態・ログ・中止」「実行履歴一覧」「選択した履歴の
// 詳細」をそれぞれ表示専用の下位コンポーネント (AgentRunCurrentStatus /
// AgentRunHistoryList / AgentRunHistoryDetail) へ move-only 抽出した。
import type {
  AgentRunDetailDto,
  AgentRunNextStepDto,
  AgentRunSummaryDto,
} from '../../api';
import { AgentRunCurrentStatus } from './AgentRunCurrentStatus';
import { AgentRunHistoryDetail } from './AgentRunHistoryDetail';
import { AgentRunHistoryList } from './AgentRunHistoryList';
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
        <AgentRunCurrentStatus
          polledRunDetail={polledRunDetail}
          activeRunMeta={activeRunMeta}
          runStatusUnavailable={runStatusUnavailable}
          copyFeedback={copyFeedback}
          onCopyNextStep={onCopyNextStep}
          cancelRunMutation={cancelRunMutation}
        />
      )}
      <AgentRunHistoryList
        ticketRunsLoading={ticketRunsLoading}
        ticketRunsError={ticketRunsError}
        ticketRunsData={ticketRunsData}
        selectedHistoryRunId={selectedHistoryRunId}
        onSelectHistoryRun={onSelectHistoryRun}
      />
      <AgentRunHistoryDetail
        selectedHistoryRunId={selectedHistoryRunId}
        copyFeedback={copyFeedback}
        onCopyNextStep={onCopyNextStep}
        selectedHistoryRunLoading={selectedHistoryRunLoading}
        selectedHistoryRunError={selectedHistoryRunError}
        selectedHistoryRun={selectedHistoryRun}
      />
    </div>
  );
}
