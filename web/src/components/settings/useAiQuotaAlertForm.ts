// bdboard-sso1.10 (PR-D): SettingsPanel.tsx の「AIクォータ通知閾値」フォームの state +
// query + mutation + effect を、挙動を変えずにこのカスタムフックへ抽出しただけのファイル。
// 呼び出し順序・依存配列・queryKey・onSuccess/onError の中身は移動前から変えていない。
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import { ApiError, fetchAiQuotaAlertConfig, putAiQuotaAlertConfig, type AiQuotaAlertConfigDto } from '../../api';
import { useSaveFeedback } from '../../hooks/useSaveFeedback';
import { describeAiQuotaAlertWriteError } from './errors';

export interface AiQuotaAlertForm {
  query: UseQueryResult<AiQuotaAlertConfigDto>;
  value: string;
  onChange: (value: string) => void;
  isSaving: boolean;
  isDirty: boolean;
  onSubmit: () => void;
  feedback: { message: ReactNode; isError: boolean };
}

export function useAiQuotaAlertForm(): AiQuotaAlertForm {
  const queryClient = useQueryClient();
  const aiQuotaAlertQuery = useQuery({
    queryKey: ['ai-quota-alert-config'],
    queryFn: fetchAiQuotaAlertConfig,
  });
  const [aiQuotaThresholdPercent, setAiQuotaThresholdPercent] = useState('');
  const [aiQuotaAlertVersion, setAiQuotaAlertVersion] = useState('');
  const aiQuotaAlertFeedback = useSaveFeedback();
  const [aiQuotaAlertDirty, setAiQuotaAlertDirty] = useState(false);

  useEffect(() => {
    if (aiQuotaAlertQuery.data !== undefined && !aiQuotaAlertDirty) {
      setAiQuotaThresholdPercent(String(aiQuotaAlertQuery.data.thresholdPercent));
      setAiQuotaAlertVersion(aiQuotaAlertQuery.data.version);
    }
  }, [aiQuotaAlertDirty, aiQuotaAlertQuery.data]);

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

  return {
    query: aiQuotaAlertQuery,
    value: aiQuotaThresholdPercent,
    onChange: (value: string) => {
      setAiQuotaThresholdPercent(value);
      setAiQuotaAlertDirty(true);
    },
    isSaving: saveAiQuotaAlertMutation.isPending,
    isDirty: aiQuotaAlertDirty,
    onSubmit: () => saveAiQuotaAlertMutation.mutate(),
    feedback: { message: aiQuotaAlertFeedback.message, isError: aiQuotaAlertFeedback.isError },
  };
}
