// bdboard-sso1.10 (PR-D): SettingsPanel.tsx の「エージェント実行」フォームの state +
// query + mutation + effect を、挙動を変えずにこのカスタムフックへ抽出しただけのファイル。
// 呼び出し順序・依存配列・queryKey・onSuccess/onError の中身は移動前から変えていない。
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import { ApiError, fetchAgentRunConfig, saveAgentRunConfig, type AgentRunConfigDto } from '../../api';
import { useSaveFeedback } from '../../hooks/useSaveFeedback';
import { describeAgentRunWriteError } from './errors';

export interface AgentRunsForm {
  query: UseQueryResult<AgentRunConfigDto>;
  checked: boolean;
  onChange: (checked: boolean) => void;
  isSaving: boolean;
  isDirty: boolean;
  onSubmit: () => void;
  feedback: { message: ReactNode; isError: boolean };
}

export function useAgentRunsForm(): AgentRunsForm {
  const queryClient = useQueryClient();
  const agentRunsQuery = useQuery({
    queryKey: ['agent-runs-config'],
    queryFn: fetchAgentRunConfig,
  });
  const [allowRemoteAgentRuns, setAllowRemoteAgentRuns] = useState(false);
  const [agentRunsVersion, setAgentRunsVersion] = useState('');
  const agentRunsFeedback = useSaveFeedback();
  const [agentRunsDirty, setAgentRunsDirty] = useState(false);

  useEffect(() => {
    if (agentRunsQuery.data !== undefined && !agentRunsDirty) {
      setAllowRemoteAgentRuns(agentRunsQuery.data.allowRemoteAgentRuns);
      setAgentRunsVersion(agentRunsQuery.data.version);
    }
  }, [agentRunsDirty, agentRunsQuery.data]);

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

  return {
    query: agentRunsQuery,
    checked: allowRemoteAgentRuns,
    onChange: (checked: boolean) => {
      setAllowRemoteAgentRuns(checked);
      setAgentRunsDirty(true);
    },
    isSaving: saveAgentRunsMutation.isPending,
    isDirty: agentRunsDirty,
    onSubmit: () => saveAgentRunsMutation.mutate(),
    feedback: { message: agentRunsFeedback.message, isError: agentRunsFeedback.isError },
  };
}
