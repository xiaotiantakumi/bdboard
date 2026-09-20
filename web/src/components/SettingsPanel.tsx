import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { ApiError, fetchAgentRunConfig, fetchAiQuotaAlertConfig, fetchBoardThresholdsConfig, fetchDbStats, fetchHygieneThresholdsConfig, fetchProjects, fetchScanRootsConfig, postRefresh, putAiQuotaAlertConfig, putBoardThresholdsConfig, putHygieneThresholdsConfig, putScanRootsConfig, saveAgentRunConfig } from '../api';
import { useSaveFeedback } from '../hooks/useSaveFeedback';
import { msToDays, msToHours, msToMinutes } from './settings/formatters';
import {
  isAbsolutePath,
  parseDays,
  parseHours,
  parseMinutes,
  parsePriorityMax,
  parseWipLimit,
} from './settings/validators';
import {
  projectWipOverridesFromConfig,
  projectWipOverridesToConfig,
  type ProjectWipOverrideRow,
} from './settings/wipOverrides';
import {
  describeAgentRunWriteError,
  describeAiQuotaAlertWriteError,
  describeBoardThresholdWriteError,
  describeHygieneThresholdWriteError,
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

export function SettingsPanel() {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ['scan-roots-config'], queryFn: fetchScanRootsConfig });
  const thresholdsQuery = useQuery({
    queryKey: ['board-thresholds-config'],
    queryFn: fetchBoardThresholdsConfig,
  });
  const hygieneThresholdsQuery = useQuery({
    queryKey: ['hygiene-thresholds-config'],
    queryFn: fetchHygieneThresholdsConfig,
  });
  const projectsQuery = useQuery({
    queryKey: ['projects'],
    queryFn: fetchProjects,
  });
  const aiQuotaAlertQuery = useQuery({
    queryKey: ['ai-quota-alert-config'],
    queryFn: fetchAiQuotaAlertConfig,
  });
  const agentRunsQuery = useQuery({
    queryKey: ['agent-runs-config'],
    queryFn: fetchAgentRunConfig,
  });
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
  const [hygieneStaleInProgressDays, setHygieneStaleInProgressDays] = useState('');
  const [hygieneHighPriorityMax, setHygieneHighPriorityMax] = useState('');
  const [hygieneStalePendingDecisionDays, setHygieneStalePendingDecisionDays] = useState('');
  const [hygieneClosedWithoutEvidenceDays, setHygieneClosedWithoutEvidenceDays] = useState('');
  const [hygieneThresholdsVersion, setHygieneThresholdsVersion] = useState('');
  const hygieneThresholdsFeedback = useSaveFeedback();
  const [hygieneThresholdsDirty, setHygieneThresholdsDirty] = useState(false);
  const [globalWipLimit, setGlobalWipLimit] = useState('');
  const [projectWipOverrides, setProjectWipOverrides] = useState<ProjectWipOverrideRow[]>([]);
  const [newWipProjectId, setNewWipProjectId] = useState('');
  const [newWipProjectLimit, setNewWipProjectLimit] = useState('');
  const wipFeedback = useSaveFeedback();
  const [wipDirty, setWipDirty] = useState(false);
  const [aiQuotaThresholdPercent, setAiQuotaThresholdPercent] = useState('');
  const [aiQuotaAlertVersion, setAiQuotaAlertVersion] = useState('');
  const aiQuotaAlertFeedback = useSaveFeedback();
  const [aiQuotaAlertDirty, setAiQuotaAlertDirty] = useState(false);
  const [allowRemoteAgentRuns, setAllowRemoteAgentRuns] = useState(false);
  const [agentRunsVersion, setAgentRunsVersion] = useState('');
  const agentRunsFeedback = useSaveFeedback();
  const [agentRunsDirty, setAgentRunsDirty] = useState(false);

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
    if (hygieneThresholdsQuery.data !== undefined && !hygieneThresholdsDirty) {
      setHygieneStaleInProgressDays(
        msToDays(hygieneThresholdsQuery.data.staleInProgressAfterMs),
      );
      setHygieneHighPriorityMax(String(hygieneThresholdsQuery.data.highPriorityMax));
      setHygieneStalePendingDecisionDays(
        msToDays(hygieneThresholdsQuery.data.stalePendingDecisionAfterMs),
      );
      setHygieneClosedWithoutEvidenceDays(
        msToDays(hygieneThresholdsQuery.data.closedWithoutEvidenceWindowMs),
      );
      setHygieneThresholdsVersion(hygieneThresholdsQuery.data.version);
    }
  }, [hygieneThresholdsDirty, hygieneThresholdsQuery.data]);

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

  useEffect(() => {
    if (aiQuotaAlertQuery.data !== undefined && !aiQuotaAlertDirty) {
      setAiQuotaThresholdPercent(String(aiQuotaAlertQuery.data.thresholdPercent));
      setAiQuotaAlertVersion(aiQuotaAlertQuery.data.version);
    }
  }, [aiQuotaAlertDirty, aiQuotaAlertQuery.data]);

  useEffect(() => {
    if (agentRunsQuery.data !== undefined && !agentRunsDirty) {
      setAllowRemoteAgentRuns(agentRunsQuery.data.allowRemoteAgentRuns);
      setAgentRunsVersion(agentRunsQuery.data.version);
    }
  }, [agentRunsDirty, agentRunsQuery.data]);

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

  const saveHygieneThresholdsMutation = useMutation({
    mutationFn: () => {
      const staleInProgressAfterMs = parseDays(hygieneStaleInProgressDays);
      const highPriorityMax = parsePriorityMax(hygieneHighPriorityMax);
      const stalePendingDecisionAfterMs = parseDays(hygieneStalePendingDecisionDays);
      const closedWithoutEvidenceWindowMs = parseDays(hygieneClosedWithoutEvidenceDays);
      if (
        staleInProgressAfterMs === undefined ||
        highPriorityMax === undefined ||
        stalePendingDecisionAfterMs === undefined ||
        closedWithoutEvidenceWindowMs === undefined
      ) {
        throw new Error('invalid local hygiene threshold input');
      }
      return putHygieneThresholdsConfig({
        staleInProgressAfterMs,
        highPriorityMax,
        stalePendingDecisionAfterMs,
        closedWithoutEvidenceWindowMs,
        version: hygieneThresholdsVersion,
      });
    },
    onSuccess: async (data) => {
      setHygieneThresholdsVersion(data.version);
      await queryClient.invalidateQueries({ queryKey: ['hygiene-thresholds-config'] });
      setHygieneThresholdsDirty(false);
      try {
        await postRefresh();
      } catch (error) {
        console.warn('Failed to refresh board after saving hygiene thresholds', error);
      }
      await queryClient.invalidateQueries({ queryKey: ['hygiene'] });
      hygieneThresholdsFeedback.showSuccess('健全性閾値を保存しました');
    },
    onError: (error) => {
      hygieneThresholdsFeedback.showError(describeHygieneThresholdWriteError(error));
      if (error instanceof ApiError && error.status === 409) {
        setHygieneThresholdsDirty(false);
        void queryClient.invalidateQueries({ queryKey: ['hygiene-thresholds-config'] });
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

  const saveAiQuotaAlertMutation = useMutation({
    mutationFn: () => {
      const thresholdPercent = Number(aiQuotaThresholdPercent.trim());
      if (!Number.isInteger(thresholdPercent)) {
        throw new Error('invalid local ai quota threshold input');
      }
      return putAiQuotaAlertConfig({
        thresholdPercent,
        version: aiQuotaAlertVersion,
      });
    },
    onSuccess: async (data) => {
      setAiQuotaAlertVersion(data.version);
      await queryClient.invalidateQueries({ queryKey: ['ai-quota-alert-config'] });
      setAiQuotaAlertDirty(false);
      aiQuotaAlertFeedback.showSuccess('AIクォータ通知閾値を保存しました');
    },
    onError: (error) => {
      aiQuotaAlertFeedback.showError(describeAiQuotaAlertWriteError(error));
      if (error instanceof ApiError && error.status === 409) {
        setAiQuotaAlertDirty(false);
        void queryClient.invalidateQueries({ queryKey: ['ai-quota-alert-config'] });
      }
    },
  });

  const saveAgentRunsMutation = useMutation({
    mutationFn: () =>
      saveAgentRunConfig({
        allowRemoteAgentRuns,
        version: agentRunsVersion,
      }),
    onSuccess: async (data) => {
      setAgentRunsVersion(data.version);
      await queryClient.invalidateQueries({ queryKey: ['agent-runs-config'] });
      setAgentRunsDirty(false);
      agentRunsFeedback.showSuccess('エージェント実行設定を保存しました');
    },
    onError: (error) => {
      agentRunsFeedback.showError(describeAgentRunWriteError(error));
      if (error instanceof ApiError && error.status === 409) {
        setAgentRunsDirty(false);
        void queryClient.invalidateQueries({ queryKey: ['agent-runs-config'] });
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
        values={{
          staleInProgressDays: hygieneStaleInProgressDays,
          highPriorityMax: hygieneHighPriorityMax,
          stalePendingDecisionDays: hygieneStalePendingDecisionDays,
          closedWithoutEvidenceDays: hygieneClosedWithoutEvidenceDays,
        }}
        data={hygieneThresholdsQuery.data}
        onStaleInProgressDaysChange={(value) => {
          setHygieneStaleInProgressDays(value);
          setHygieneThresholdsDirty(true);
        }}
        onHighPriorityMaxChange={(value) => {
          setHygieneHighPriorityMax(value);
          setHygieneThresholdsDirty(true);
        }}
        onStalePendingDecisionDaysChange={(value) => {
          setHygieneStalePendingDecisionDays(value);
          setHygieneThresholdsDirty(true);
        }}
        onClosedWithoutEvidenceDaysChange={(value) => {
          setHygieneClosedWithoutEvidenceDays(value);
          setHygieneThresholdsDirty(true);
        }}
        isSaving={saveHygieneThresholdsMutation.isPending}
        isDirty={hygieneThresholdsDirty}
        onSubmit={() => saveHygieneThresholdsMutation.mutate()}
        feedback={{
          message: hygieneThresholdsFeedback.message,
          isError: hygieneThresholdsFeedback.isError,
        }}
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
        value={aiQuotaThresholdPercent}
        onChange={(value) => {
          setAiQuotaThresholdPercent(value);
          setAiQuotaAlertDirty(true);
        }}
        defaultPercent={aiQuotaAlertQuery.data.defaults.thresholdPercent}
        isSaving={saveAiQuotaAlertMutation.isPending}
        isDirty={aiQuotaAlertDirty}
        onSubmit={() => saveAiQuotaAlertMutation.mutate()}
        feedback={{
          message: aiQuotaAlertFeedback.message,
          isError: aiQuotaAlertFeedback.isError,
        }}
      />
      <AgentRunsSection
        checked={allowRemoteAgentRuns}
        onChange={(checked) => {
          setAllowRemoteAgentRuns(checked);
          setAgentRunsDirty(true);
        }}
        isSaving={saveAgentRunsMutation.isPending}
        isDirty={agentRunsDirty}
        onSubmit={() => saveAgentRunsMutation.mutate()}
        feedback={{ message: agentRunsFeedback.message, isError: agentRunsFeedback.isError }}
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
