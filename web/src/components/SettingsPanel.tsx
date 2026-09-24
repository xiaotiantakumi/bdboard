import { useQuery } from '@tanstack/react-query';
import { fetchDbStats } from '../api';
import { EffectiveScanRootsSection } from './settings/EffectiveScanRootsSection';
import { ScanRootsSection } from './settings/ScanRootsSection';
import { ExcludePathsSection } from './settings/ExcludePathsSection';
import { DbStatsSection } from './settings/DbStatsSection';
import { BoardThresholdsSection } from './settings/BoardThresholdsSection';
import { HygieneThresholdsSection } from './settings/HygieneThresholdsSection';
import { WipLimitsSection } from './settings/WipLimitsSection';
import { AiQuotaAlertSection } from './settings/AiQuotaAlertSection';
import { AgentRunsSection } from './settings/AgentRunsSection';
import { useAiQuotaAlertForm } from './settings/useAiQuotaAlertForm';
import { useAgentRunsForm } from './settings/useAgentRunsForm';
import { useHygieneThresholdsForm } from './settings/useHygieneThresholdsForm';
import { useScanRootsForm } from './settings/useScanRootsForm';
import { useBoardThresholdsForm } from './settings/useBoardThresholdsForm';
import { useWipLimitsForm } from './settings/useWipLimitsForm';
import { useThresholdsSharedState } from './settings/useThresholdsSharedState';

export function SettingsPanel() {
  const scanRootsForm = useScanRootsForm();
  const query = scanRootsForm.query;
  const thresholdsShared = useThresholdsSharedState();
  const thresholdsQuery = thresholdsShared.query;
  const hygieneThresholdsForm = useHygieneThresholdsForm();
  const hygieneThresholdsQuery = hygieneThresholdsForm.query;
  const aiQuotaAlertForm = useAiQuotaAlertForm();
  const aiQuotaAlertQuery = aiQuotaAlertForm.query;
  const agentRunsForm = useAgentRunsForm();
  const agentRunsQuery = agentRunsForm.query;
  const dbStatsQuery = useQuery({
    queryKey: ['db-stats'],
    queryFn: fetchDbStats,
  });

  const boardThresholdsForm = useBoardThresholdsForm({
    query: thresholdsShared.query,
    version: thresholdsShared.version,
    onVersionChange: thresholdsShared.onVersionChange,
    dirty: thresholdsShared.thresholdsDirty,
    onDirtyChange: thresholdsShared.setThresholdsDirty,
  });
  const wipLimitsForm = useWipLimitsForm({
    query: thresholdsShared.query,
    version: thresholdsShared.version,
    onVersionChange: thresholdsShared.onVersionChange,
    dirty: thresholdsShared.wipDirty,
    onDirtyChange: thresholdsShared.setWipDirty,
  });

  if (
    query.isPending ||
    thresholdsQuery.isPending ||
    hygieneThresholdsQuery.isPending ||
    aiQuotaAlertQuery.isPending ||
    agentRunsQuery.isPending
  ) {
    return (
      <section className="settings-panel" aria-label="設定">
        読み込み中…
      </section>
    );
  }
  if (
    query.isError ||
    query.data === undefined ||
    thresholdsQuery.isError ||
    thresholdsQuery.data === undefined ||
    hygieneThresholdsQuery.isError ||
    hygieneThresholdsQuery.data === undefined ||
    aiQuotaAlertQuery.isError ||
    aiQuotaAlertQuery.data === undefined ||
    agentRunsQuery.isError ||
    agentRunsQuery.data === undefined
  ) {
    return (
      <section className="settings-panel" aria-label="設定">
        <p className="settings-panel-error">設定を読み込めませんでした</p>
      </section>
    );
  }

  const currentRoots = query.data.envOverride
    ? query.data.envScanRoots
    : query.data.scanRoots.length > 0
      ? query.data.scanRoots
      : query.data.defaultScanRoots;
  const currentLabel = query.data.envOverride
    ? '環境変数'
    : query.data.scanRoots.length > 0
      ? 'ユーザー設定'
      : 'OS既定';

  return (
    <section className="settings-panel" aria-label="設定">
      <div className="settings-panel-header">
        <h2 className="settings-panel-title">設定</h2>
        <p className="settings-panel-subtitle">
          プロジェクトを探索するスキャンルートと除外パスを設定します。
        </p>
      </div>
      {query.data.envOverride && (
        <div className="settings-panel-warning" role="alert">
          環境変数 BDBOARD_SCAN_ROOTS が設定されているため、この画面での設定は現在無視されています
        </div>
      )}
      <EffectiveScanRootsSection currentLabel={currentLabel} currentRoots={currentRoots} />
      <ScanRootsSection
        envOverride={query.data.envOverride}
        scanRoots={scanRootsForm.scanRoots}
        onRemovePath={scanRootsForm.onRemovePath}
        isSaving={scanRootsForm.isSaving}
        newPath={scanRootsForm.newPath}
        onNewPathChange={scanRootsForm.onNewPathChange}
        pathHint={scanRootsForm.pathHint}
        onAddPath={scanRootsForm.onAddPath}
      />
      <ExcludePathsSection
        envOverride={query.data.envOverride}
        excludePaths={scanRootsForm.excludePaths}
        onRemoveExcludePath={scanRootsForm.onRemoveExcludePath}
        isSaving={scanRootsForm.isSaving}
        newExcludePath={scanRootsForm.newExcludePath}
        onNewExcludePathChange={scanRootsForm.onNewExcludePathChange}
        excludePathHint={scanRootsForm.excludePathHint}
        onAddExcludePath={scanRootsForm.onAddExcludePath}
      />
      {/* boardThresholdsForm のキーは BoardThresholdsSectionProps から defaults を除いたものと
          1対1で一致するよう useBoardThresholdsForm 側で設計しているため spread で渡す。 */}
      <BoardThresholdsSection {...boardThresholdsForm} defaults={thresholdsQuery.data.defaults} />
      <HygieneThresholdsSection
        values={hygieneThresholdsForm.values}
        data={hygieneThresholdsQuery.data}
        onStaleInProgressDaysChange={hygieneThresholdsForm.onStaleInProgressDaysChange}
        onHighPriorityMaxChange={hygieneThresholdsForm.onHighPriorityMaxChange}
        onStalePendingDecisionDaysChange={hygieneThresholdsForm.onStalePendingDecisionDaysChange}
        onClosedWithoutEvidenceDaysChange={hygieneThresholdsForm.onClosedWithoutEvidenceDaysChange}
        isSaving={hygieneThresholdsForm.isSaving}
        isDirty={hygieneThresholdsForm.isDirty}
        onSubmit={hygieneThresholdsForm.onSubmit}
        feedback={hygieneThresholdsForm.feedback}
      />
      {/* wipLimitsForm のキーは WipLimitsSectionProps と1対1で一致するよう
          useWipLimitsForm 側で設計しているため spread で渡す。 */}
      <WipLimitsSection {...wipLimitsForm} />
      <AiQuotaAlertSection
        value={aiQuotaAlertForm.value}
        onChange={aiQuotaAlertForm.onChange}
        defaultPercent={aiQuotaAlertQuery.data.defaults.thresholdPercent}
        isSaving={aiQuotaAlertForm.isSaving}
        isDirty={aiQuotaAlertForm.isDirty}
        onSubmit={aiQuotaAlertForm.onSubmit}
        feedback={aiQuotaAlertForm.feedback}
      />
      <AgentRunsSection
        checked={agentRunsForm.checked}
        onChange={agentRunsForm.onChange}
        isSaving={agentRunsForm.isSaving}
        isDirty={agentRunsForm.isDirty}
        onSubmit={agentRunsForm.onSubmit}
        feedback={agentRunsForm.feedback}
      />
      <DbStatsSection isPending={dbStatsQuery.isPending} isError={dbStatsQuery.isError} data={dbStatsQuery.data} />
      <div className="settings-panel-footer">
        <button
          type="button"
          className="settings-panel-save"
          disabled={!scanRootsForm.isDirty || scanRootsForm.isSaving}
          onClick={() => scanRootsForm.onSubmit()}
        >
          {scanRootsForm.isSaving ? '保存中…' : '保存'}
        </button>
        <p
          className="settings-panel-feedback"
          aria-live="polite"
          role={scanRootsForm.feedback.isError ? 'alert' : undefined}
        >
          {scanRootsForm.feedback.message}
        </p>
      </div>
    </section>
  );
}
