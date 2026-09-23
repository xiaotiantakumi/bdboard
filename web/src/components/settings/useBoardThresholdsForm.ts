// bdboard-sso1.68: SettingsPanel.tsx の「滞留・liveness 閾値」フォーム (BoardThresholdsSection) が
// 読む state + effect + mutation を、挙動を変えずにこのカスタムフックへ抽出しただけのファイル。
// 呼び出し順序・依存配列・queryKey・onSuccess/onError の中身は移動前から変えていない。
//
// version と dirty フラグはこのフックの外(親の SettingsPanel)が持つ。閾値フォームと
// WIP上限フォーム (useWipLimitsForm) は、サーバー側では同じ設定ドキュメント
// (board-thresholds-config) = 同じ version を共有しており、version の書き戻しは
// 両方のフォームが未編集のときに限る (bdboard-chp) ため、共有 state は親に残している。
import { useMutation, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import {
  ApiError,
  postRefresh,
  putBoardThresholdsConfig,
  type BoardThresholdsConfigDto,
} from '../../api';
import { useSaveFeedback } from '../../hooks/useSaveFeedback';
import { msToHours, msToMinutes } from './formatters';
import { parseHours, parseMinutes } from './validators';
import { describeBoardThresholdWriteError } from './errors';

export interface UseBoardThresholdsFormParams {
  query: UseQueryResult<BoardThresholdsConfigDto>;
  version: string;
  onVersionChange: (version: string) => void;
  dirty: boolean;
  onDirtyChange: (dirty: boolean) => void;
}

export interface BoardThresholdsForm {
  values: {
    stalledHours: string;
    activeMinutes: string;
    idleMinutes: string;
    staleHours: string;
  };
  onStalledHoursChange: (value: string) => void;
  onActiveMinutesChange: (value: string) => void;
  onIdleMinutesChange: (value: string) => void;
  onStaleHoursChange: (value: string) => void;
  isSaving: boolean;
  isDirty: boolean;
  onSubmit: () => void;
  feedback: { message: ReactNode; isError: boolean };
}

export function useBoardThresholdsForm({
  query,
  version,
  onVersionChange,
  dirty,
  onDirtyChange,
}: UseBoardThresholdsFormParams): BoardThresholdsForm {
  const queryClient = useQueryClient();
  const [stalledHours, setStalledHours] = useState('');
  const [activeMinutes, setActiveMinutes] = useState('');
  const [idleMinutes, setIdleMinutes] = useState('');
  const [staleHours, setStaleHours] = useState('');
  const thresholdsFeedback = useSaveFeedback();

  useEffect(() => {
    if (query.data !== undefined && !dirty) {
      setStalledHours(msToHours(query.data.stalledAfterMs));
      setActiveMinutes(msToMinutes(query.data.livenessActiveMs));
      setIdleMinutes(msToMinutes(query.data.livenessIdleMs));
      setStaleHours(msToHours(query.data.livenessStaleMs));
    }
  }, [dirty, query.data]);

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
        version,
      });
    },
    onSuccess: async (data) => {
      onVersionChange(data.version);
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
      onDirtyChange(false);
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
        onDirtyChange(false);
        void queryClient.invalidateQueries({ queryKey: ['board-thresholds-config'] });
      }
    },
  });

  return {
    values: {
      stalledHours,
      activeMinutes,
      idleMinutes,
      staleHours,
    },
    onStalledHoursChange: (value: string) => {
      setStalledHours(value);
      onDirtyChange(true);
    },
    onActiveMinutesChange: (value: string) => {
      setActiveMinutes(value);
      onDirtyChange(true);
    },
    onIdleMinutesChange: (value: string) => {
      setIdleMinutes(value);
      onDirtyChange(true);
    },
    onStaleHoursChange: (value: string) => {
      setStaleHours(value);
      onDirtyChange(true);
    },
    isSaving: saveThresholdsMutation.isPending,
    isDirty: dirty,
    onSubmit: () => saveThresholdsMutation.mutate(),
    feedback: { message: thresholdsFeedback.message, isError: thresholdsFeedback.isError },
  };
}
