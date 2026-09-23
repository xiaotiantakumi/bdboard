// bdboard-sso1.68: SettingsPanel.tsx の「WIP上限」フォーム (WipLimitsSection) が読む
// state + query + effect + mutation を、挙動を変えずにこのカスタムフックへ抽出しただけの
// ファイル。呼び出し順序・依存配列・queryKey・onSuccess/onError の中身は移動前から
// 変えていない。
//
// version と dirty フラグはこのフックの外(親の SettingsPanel)が持つ。理由は
// useBoardThresholdsForm.ts の冒頭コメントと同じ (bdboard-chp): 閾値フォームと
// WIP上限フォームはサーバー側で同じ設定ドキュメント = 同じ version を共有している。
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import {
  ApiError,
  fetchProjects,
  postRefresh,
  putBoardThresholdsConfig,
  type BoardThresholdsConfigDto,
  type ProjectDto,
} from '../../api';
import { useSaveFeedback } from '../../hooks/useSaveFeedback';
import { parseWipLimit } from './validators';
import {
  projectWipOverridesFromConfig,
  projectWipOverridesToConfig,
  type ProjectWipOverrideRow,
} from './wipOverrides';
import { describeBoardThresholdWriteError } from './errors';

export interface UseWipLimitsFormParams {
  query: UseQueryResult<BoardThresholdsConfigDto>;
  version: string;
  onVersionChange: (version: string) => void;
  dirty: boolean;
  onDirtyChange: (dirty: boolean) => void;
}

export interface WipLimitsForm {
  global: {
    value: string;
    onChange: (value: string) => void;
  };
  overrides: {
    rows: ProjectWipOverrideRow[];
    projects: ProjectDto[] | undefined;
    projectsPending: boolean;
    onLimitChange: (index: number, value: string) => void;
    onRemove: (index: number) => void;
  };
  addRow: {
    projectId: string;
    onProjectIdChange: (value: string) => void;
    limit: string;
    onLimitChange: (value: string) => void;
    onAdd: () => void;
  };
  isSaving: boolean;
  isDirty: boolean;
  onSubmit: () => void;
  feedback: { message: ReactNode; isError: boolean };
}

export function useWipLimitsForm({
  query,
  version,
  onVersionChange,
  dirty,
  onDirtyChange,
}: UseWipLimitsFormParams): WipLimitsForm {
  const queryClient = useQueryClient();
  const projectsQuery = useQuery({
    queryKey: ['projects'],
    queryFn: fetchProjects,
  });
  const [globalWipLimit, setGlobalWipLimit] = useState('');
  const [projectWipOverrides, setProjectWipOverrides] = useState<ProjectWipOverrideRow[]>([]);
  const [newWipProjectId, setNewWipProjectId] = useState('');
  const [newWipProjectLimit, setNewWipProjectLimit] = useState('');
  const wipFeedback = useSaveFeedback();

  useEffect(() => {
    if (query.data !== undefined && !dirty) {
      setGlobalWipLimit(
        query.data.inProgressWipLimit !== null ? String(query.data.inProgressWipLimit) : '',
      );
      setProjectWipOverrides(projectWipOverridesFromConfig(query.data.inProgressWipLimitByProject));
    }
  }, [dirty, query.data]);

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
        version,
      });
    },
    onSuccess: async (data) => {
      onVersionChange(data.version);
      await queryClient.invalidateQueries({ queryKey: ['board-thresholds-config'] });
      onDirtyChange(false);
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
        onDirtyChange(false);
        void queryClient.invalidateQueries({ queryKey: ['board-thresholds-config'] });
      }
    },
  });

  return {
    global: {
      value: globalWipLimit,
      onChange: (value: string) => {
        setGlobalWipLimit(value);
        onDirtyChange(true);
      },
    },
    overrides: {
      rows: projectWipOverrides,
      projects: projectsQuery.data,
      projectsPending: projectsQuery.isPending,
      onLimitChange: (index: number, value: string) => {
        setProjectWipOverrides((current) =>
          current.map((entry, entryIndex) =>
            entryIndex === index ? { ...entry, limit: value } : entry,
          ),
        );
        onDirtyChange(true);
      },
      onRemove: (index: number) => {
        setProjectWipOverrides((current) => current.filter((_, entryIndex) => entryIndex !== index));
        onDirtyChange(true);
      },
    },
    addRow: {
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
        onDirtyChange(true);
      },
    },
    isSaving: saveWipLimitsMutation.isPending,
    isDirty: dirty,
    onSubmit: () => saveWipLimitsMutation.mutate(),
    feedback: { message: wipFeedback.message, isError: wipFeedback.isError },
  };
}
