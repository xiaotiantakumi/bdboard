// bdboard-sso1.10 (PR-E): SettingsPanel.tsx の「健全性 (Hygiene) 閾値」フォームの state +
// query + mutation + effect を、挙動を変えずにこのカスタムフックへ抽出しただけのファイル。
// 呼び出し順序・依存配列・queryKey・onSuccess/onError の中身は移動前から変えていない。
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import {
  ApiError,
  fetchHygieneThresholdsConfig,
  postRefresh,
  putHygieneThresholdsConfig,
  type HygieneThresholdsConfigDto,
} from '../../api';
import { useSaveFeedback } from '../../hooks/useSaveFeedback';
import { msToDays } from './formatters';
import { parseDays, parsePriorityMax } from './validators';
import { describeHygieneThresholdWriteError } from './errors';

export interface HygieneThresholdsForm {
  query: UseQueryResult<HygieneThresholdsConfigDto>;
  values: {
    staleInProgressDays: string;
    highPriorityMax: string;
    stalePendingDecisionDays: string;
    closedWithoutEvidenceDays: string;
  };
  onStaleInProgressDaysChange: (value: string) => void;
  onHighPriorityMaxChange: (value: string) => void;
  onStalePendingDecisionDaysChange: (value: string) => void;
  onClosedWithoutEvidenceDaysChange: (value: string) => void;
  isSaving: boolean;
  isDirty: boolean;
  onSubmit: () => void;
  feedback: { message: ReactNode; isError: boolean };
}

export function useHygieneThresholdsForm(): HygieneThresholdsForm {
  const queryClient = useQueryClient();
  const hygieneThresholdsQuery = useQuery({
    queryKey: ['hygiene-thresholds-config'],
    queryFn: fetchHygieneThresholdsConfig,
  });
  const [hygieneStaleInProgressDays, setHygieneStaleInProgressDays] = useState('');
  const [hygieneHighPriorityMax, setHygieneHighPriorityMax] = useState('');
  const [hygieneStalePendingDecisionDays, setHygieneStalePendingDecisionDays] = useState('');
  const [hygieneClosedWithoutEvidenceDays, setHygieneClosedWithoutEvidenceDays] = useState('');
  const [hygieneThresholdsVersion, setHygieneThresholdsVersion] = useState('');
  const hygieneThresholdsFeedback = useSaveFeedback();
  const [hygieneThresholdsDirty, setHygieneThresholdsDirty] = useState(false);

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

  return {
    query: hygieneThresholdsQuery,
    values: {
      staleInProgressDays: hygieneStaleInProgressDays,
      highPriorityMax: hygieneHighPriorityMax,
      stalePendingDecisionDays: hygieneStalePendingDecisionDays,
      closedWithoutEvidenceDays: hygieneClosedWithoutEvidenceDays,
    },
    onStaleInProgressDaysChange: (value: string) => {
      setHygieneStaleInProgressDays(value);
      setHygieneThresholdsDirty(true);
    },
    onHighPriorityMaxChange: (value: string) => {
      setHygieneHighPriorityMax(value);
      setHygieneThresholdsDirty(true);
    },
    onStalePendingDecisionDaysChange: (value: string) => {
      setHygieneStalePendingDecisionDays(value);
      setHygieneThresholdsDirty(true);
    },
    onClosedWithoutEvidenceDaysChange: (value: string) => {
      setHygieneClosedWithoutEvidenceDays(value);
      setHygieneThresholdsDirty(true);
    },
    isSaving: saveHygieneThresholdsMutation.isPending,
    isDirty: hygieneThresholdsDirty,
    onSubmit: () => saveHygieneThresholdsMutation.mutate(),
    feedback: {
      message: hygieneThresholdsFeedback.message,
      isError: hygieneThresholdsFeedback.isError,
    },
  };
}
