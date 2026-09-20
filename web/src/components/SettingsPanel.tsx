import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { ApiError, fetchBoardThresholdsConfig, fetchDbStats, fetchProjects, fetchScanRootsConfig, postRefresh, putBoardThresholdsConfig, putScanRootsConfig } from '../api';
import { useSaveFeedback } from '../hooks/useSaveFeedback';
import { msToHours, msToMinutes } from './settings/formatters';
import {
  isAbsolutePath,
  parseHours,
  parseMinutes,
  parseWipLimit,
} from './settings/validators';
import {
  projectWipOverridesFromConfig,
  projectWipOverridesToConfig,
  type ProjectWipOverrideRow,
} from './settings/wipOverrides';
import {
  describeBoardThresholdWriteError,
  describeScanRootWriteError,
} from './settings/errors';
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

export function SettingsPanel() {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ['scan-roots-config'], queryFn: fetchScanRootsConfig });
  const thresholdsQuery = useQuery({
    queryKey: ['board-thresholds-config'],
    queryFn: fetchBoardThresholdsConfig,
  });
  const hygieneThresholdsForm = useHygieneThresholdsForm();
  const hygieneThresholdsQuery = hygieneThresholdsForm.query;
  const projectsQuery = useQuery({
    queryKey: ['projects'],
    queryFn: fetchProjects,
  });
  const aiQuotaAlertForm = useAiQuotaAlertForm();
  const aiQuotaAlertQuery = aiQuotaAlertForm.query;
  const agentRunsForm = useAgentRunsForm();
  const agentRunsQuery = agentRunsForm.query;
  const dbStatsQuery = useQuery({
    queryKey: ['db-stats'],
    queryFn: fetchDbStats,
  });
  const [scanRoots, setScanRoots] = useState<string[]>([]);
  const [excludePaths, setExcludePaths] = useState<string[]>([]);
  const [version, setVersion] = useState('');
  const [newPath, setNewPath] = useState('');
  const [newExcludePath, setNewExcludePath] = useState('');
  const scanRootsFeedback = useSaveFeedback();
  const [pathHint, setPathHint] = useState('');
  const [excludePathHint, setExcludePathHint] = useState('');
  const [dirty, setDirty] = useState(false);
  const [stalledHours, setStalledHours] = useState('');
  const [activeMinutes, setActiveMinutes] = useState('');
  const [idleMinutes, setIdleMinutes] = useState('');
  const [staleHours, setStaleHours] = useState('');
  const [thresholdsVersion, setThresholdsVersion] = useState('');
  const thresholdsFeedback = useSaveFeedback();
  const [thresholdsDirty, setThresholdsDirty] = useState(false);
  const [globalWipLimit, setGlobalWipLimit] = useState('');
  const [projectWipOverrides, setProjectWipOverrides] = useState<ProjectWipOverrideRow[]>([]);
  const [newWipProjectId, setNewWipProjectId] = useState('');
  const [newWipProjectLimit, setNewWipProjectLimit] = useState('');
  const wipFeedback = useSaveFeedback();
  const [wipDirty, setWipDirty] = useState(false);

  useEffect(() => {
    if (query.data !== undefined && !dirty) {
      setScanRoots(query.data.scanRoots);
      setExcludePaths(query.data.excludePaths);
      setVersion(query.data.version);
    }
  }, [dirty, query.data]);

  useEffect(() => {
    if (thresholdsQuery.data !== undefined && !thresholdsDirty) {
      setStalledHours(msToHours(thresholdsQuery.data.stalledAfterMs));
      setActiveMinutes(msToMinutes(thresholdsQuery.data.livenessActiveMs));
      setIdleMinutes(msToMinutes(thresholdsQuery.data.livenessIdleMs));
      setStaleHours(msToHours(thresholdsQuery.data.livenessStaleMs));
    }
  }, [thresholdsDirty, thresholdsQuery.data]);

  useEffect(() => {
    if (thresholdsQuery.data !== undefined && !wipDirty) {
      setGlobalWipLimit(
        thresholdsQuery.data.inProgressWipLimit !== null
          ? String(thresholdsQuery.data.inProgressWipLimit)
          : '',
      );
      setProjectWipOverrides(
        projectWipOverridesFromConfig(thresholdsQuery.data.inProgressWipLimitByProject),
      );
    }
  }, [wipDirty, thresholdsQuery.data]);

  // 閾値フォームと WIP上限フォームは、サーバー側では1つの設定ドキュメント =
  // 1つの version を共有している。そのため version の書き戻しは、**どちらの
  // フォームにも未保存の編集が無いとき**に限る。
  //
  // 以前は上の2つの effect がそれぞれ自分の dirty フラグだけを見て version を
  // 更新していた。片方だけを編集していると、もう片方の effect が refetch のたびに
  // version を最新へ差し替えてしまい、保存時に 409 が出ず他セッションの変更を
  // 黙って上書きしていた (bdboard-chp)。楽観ロックが効いていたのは「両方とも
  // 編集中」のときだけだった。
  //
  // 逆に、どちらも未編集なら素直に進める必要がある。ここまで止めると、開いた
  // ままのタブから保存すると必ず 409 になる。
  useEffect(() => {
    if (thresholdsQuery.data !== undefined && !thresholdsDirty && !wipDirty) {
      setThresholdsVersion(thresholdsQuery.data.version);
    }
  }, [thresholdsDirty, wipDirty, thresholdsQuery.data]);

  const saveMutation = useMutation({
    mutationFn: () =>
      putScanRootsConfig({
        scanRoots,
        excludePaths,
        version,
      }),
    onSuccess: async (data) => {
      // S3: the PUT response carries the version the server actually persisted this write as —
      // use it directly instead of waiting on the subsequent GET (invalidateQueries still runs,
      // to keep scanRoots/excludePaths in sync with the server's canonical trimmed/normalized
      // values, but the version itself doesn't need to round-trip through a refetch).
      setVersion(data.version);
      await queryClient.invalidateQueries({ queryKey: ['scan-roots-config'] });
      setDirty(false);
      try {
        await postRefresh();
      } catch (error) {
        console.warn('Failed to refresh board after saving scan roots', error);
      }
      await queryClient.invalidateQueries({ queryKey: ['projects'] });
      scanRootsFeedback.showSuccess('設定を保存しました');
    },
    onError: (error) => {
      scanRootsFeedback.showError(describeScanRootWriteError(error));
      if (error instanceof ApiError && error.status === 409) {
        setDirty(false);
        void queryClient.invalidateQueries({ queryKey: ['scan-roots-config'] });
      }
    },
  });

  const saveThresholdsMutation = useMutation({
    mutationFn: () => {
      const stalledAfterMs = parseHours(stalledHours);
      const livenessActiveMs = parseMinutes(activeMinutes);
      const livenessIdleMs = parseMinutes(idleMinutes);
      const livenessStaleMs = parseHours(staleHours);
      if (
        stalledAfterMs === undefined ||
        livenessActiveMs === undefined ||
        livenessIdleMs === undefined ||
        livenessStaleMs === undefined
      ) {
        throw new Error('invalid local threshold input');
      }
      return putBoardThresholdsConfig({
        stalledAfterMs,
        livenessActiveMs,
        livenessIdleMs,
        livenessStaleMs,
        version: thresholdsVersion,
      });
    },
    onSuccess: async (data) => {
      setThresholdsVersion(data.version);
      await queryClient.invalidateQueries({ queryKey: ['board-thresholds-config'] });
      // liveness 閾値はセッション系のDTOにも効く (bdboard-3tw.102.5)。下の
      // postRefresh が起こすのは board.changed で、これは board 系しか
      // 無効化しないため、ヘッダーの「稼働中 N」(['sessions']) とプロジェクト
      // 一覧 (['projects']) だけが古い閾値のまま残る。全エージェントが
      // 停止している間は session.changed も飛ばないので、放っておくと
      // ウィンドウを再フォーカスするまで食い違ったままになる。
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['sessions'] }),
        queryClient.invalidateQueries({ queryKey: ['projects'] }),
      ]);
      setThresholdsDirty(false);
      try {
        await postRefresh();
      } catch (error) {
        console.warn('Failed to refresh board after saving board thresholds', error);
      }
      thresholdsFeedback.showSuccess('閾値設定を保存しました');
    },
    onError: (error) => {
      thresholdsFeedback.showError(describeBoardThresholdWriteError(error));
      if (error instanceof ApiError && error.status === 409) {
        setThresholdsDirty(false);
        void queryClient.invalidateQueries({ queryKey: ['board-thresholds-config'] });
      }
    },
  });

  const saveWipLimitsMutation = useMutation({
    mutationFn: () => {
      const trimmedGlobal = globalWipLimit.trim();
      const parsedGlobal = trimmedGlobal.length === 0 ? null : parseWipLimit(trimmedGlobal);
      if (trimmedGlobal.length > 0 && parsedGlobal === undefined) {
        throw new Error('invalid local wip limit input');
      }
      const byProject = projectWipOverridesToConfig(projectWipOverrides);
      return putBoardThresholdsConfig({
        inProgressWipLimit: parsedGlobal,
        inProgressWipLimitByProject: byProject,
        version: thresholdsVersion,
      });
    },
    onSuccess: async (data) => {
      setThresholdsVersion(data.version);
      await queryClient.invalidateQueries({ queryKey: ['board-thresholds-config'] });
      setWipDirty(false);
      try {
        await postRefresh();
      } catch (error) {
        console.warn('Failed to refresh board after saving wip limits', error);
      }
      wipFeedback.showSuccess('WIP上限を保存しました');
    },
    onError: (error) => {
      wipFeedback.showError(describeBoardThresholdWriteError(error));
      if (error instanceof ApiError && error.status === 409) {
        setWipDirty(false);
        void queryClient.invalidateQueries({ queryKey: ['board-thresholds-config'] });
      }
    },
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

  function addPath() {
    const path = newPath.trim();
    if (path.length === 0 || !isAbsolutePath(path)) {
      setPathHint(
        '絶対パスを入力してください (例: /Users/you/projects, C:\\Users\\you\\projects)',
      );
      return;
    }
    if (scanRoots.includes(path)) {
      setPathHint('既に追加されています');
      return;
    }
    setScanRoots((roots) => [...roots, path]);
    setDirty(true);
    setNewPath('');
    setPathHint('');
  }

  function removePath(path: string) {
    setScanRoots((roots) => roots.filter((root) => root !== path));
    setDirty(true);
  }

  function addExcludePath() {
    // Discovery matches `excluded` itself or the `excluded + '/'` prefix, so a trailing
    // separator would silently disable the exclusion — strip it before validating/saving.
    const path = newExcludePath.trim().replace(/[\\/]+$/, '');
    if (path.length === 0 || !isAbsolutePath(path)) {
      setExcludePathHint(
        '絶対パスを入力してください (例: /Users/you/projects, C:/Users/you/projects)',
      );
      return;
    }
    if (excludePaths.includes(path)) {
      setExcludePathHint('既に追加されています');
      return;
    }
    setExcludePaths((paths) => [...paths, path]);
    setDirty(true);
    setNewExcludePath('');
    setExcludePathHint('');
  }

  function removeExcludePath(path: string) {
    setExcludePaths((paths) => paths.filter((currentPath) => currentPath !== path));
    setDirty(true);
  }

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
        scanRoots={scanRoots}
        onRemovePath={removePath}
        isSaving={saveMutation.isPending}
        newPath={newPath}
        onNewPathChange={setNewPath}
        pathHint={pathHint}
        onAddPath={addPath}
      />
      <ExcludePathsSection
        envOverride={query.data.envOverride}
        excludePaths={excludePaths}
        onRemoveExcludePath={removeExcludePath}
        isSaving={saveMutation.isPending}
        newExcludePath={newExcludePath}
        onNewExcludePathChange={setNewExcludePath}
        excludePathHint={excludePathHint}
        onAddExcludePath={addExcludePath}
      />
      <BoardThresholdsSection
        values={{
          stalledHours,
          activeMinutes,
          idleMinutes,
          staleHours,
        }}
        defaults={thresholdsQuery.data.defaults}
        onStalledHoursChange={(value) => {
          setStalledHours(value);
          setThresholdsDirty(true);
        }}
        onActiveMinutesChange={(value) => {
          setActiveMinutes(value);
          setThresholdsDirty(true);
        }}
        onIdleMinutesChange={(value) => {
          setIdleMinutes(value);
          setThresholdsDirty(true);
        }}
        onStaleHoursChange={(value) => {
          setStaleHours(value);
          setThresholdsDirty(true);
        }}
        isSaving={saveThresholdsMutation.isPending}
        isDirty={thresholdsDirty}
        onSubmit={() => saveThresholdsMutation.mutate()}
        feedback={{ message: thresholdsFeedback.message, isError: thresholdsFeedback.isError }}
      />
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
      <WipLimitsSection
        global={{
          value: globalWipLimit,
          onChange: (value) => {
            setGlobalWipLimit(value);
            setWipDirty(true);
          },
        }}
        overrides={{
          rows: projectWipOverrides,
          projects: projectsQuery.data,
          projectsPending: projectsQuery.isPending,
          onLimitChange: (index, value) => {
            setProjectWipOverrides((current) =>
              current.map((entry, entryIndex) =>
                entryIndex === index ? { ...entry, limit: value } : entry,
              ),
            );
            setWipDirty(true);
          },
          onRemove: (index) => {
            setProjectWipOverrides((current) =>
              current.filter((_, entryIndex) => entryIndex !== index),
            );
            setWipDirty(true);
          },
        }}
        addRow={{
          projectId: newWipProjectId,
          onProjectIdChange: setNewWipProjectId,
          limit: newWipProjectLimit,
          onLimitChange: setNewWipProjectLimit,
          onAdd: () => {
            const limit = parseWipLimit(newWipProjectLimit);
            if (newWipProjectId === '' || limit === undefined) {
              return;
            }
            setProjectWipOverrides((current) => [
              ...current,
              { projectId: newWipProjectId, limit: String(limit) },
            ]);
            setNewWipProjectId('');
            setNewWipProjectLimit('');
            setWipDirty(true);
          },
        }}
        isSaving={saveWipLimitsMutation.isPending}
        isDirty={wipDirty}
        onSubmit={() => saveWipLimitsMutation.mutate()}
        feedback={{ message: wipFeedback.message, isError: wipFeedback.isError }}
      />
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
      <DbStatsSection
        isPending={dbStatsQuery.isPending}
        isError={dbStatsQuery.isError}
        data={dbStatsQuery.data}
      />
      <div className="settings-panel-footer">
        <button
          type="button"
          className="settings-panel-save"
          disabled={!dirty || saveMutation.isPending}
          onClick={() => saveMutation.mutate()}
        >
          {saveMutation.isPending ? '保存中…' : '保存'}
        </button>
        <p
          className="settings-panel-feedback"
          aria-live="polite"
          role={scanRootsFeedback.isError ? 'alert' : undefined}
        >
          {scanRootsFeedback.message}
        </p>
      </div>
    </section>
  );
}
