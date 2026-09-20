// bdboard-sso1.5 (PR-D): TicketDetailPanel.tsx の「タイトル編集」に関する
// state + mutation + handler 一式を、挙動を変えずにこのカスタムフックへ抽出
// しただけのファイル。SettingsPanel.tsx の useAiQuotaAlertForm /
// HygienePanel.tsx の useHygieneRepairActions と同じ抽出パターン。呼び出し
// 順序・依存配列・queryKey・onSuccess/onError の中身は移動前から変えていない。
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';
import { ApiError, patchTicketTitle } from '../../api';

export interface TicketTitleEditing {
  readonly titleEditing: boolean;
  readonly titleDraft: string;
  readonly canSaveTitle: boolean;
  readonly isSaving: boolean;
  readonly error: unknown;
  readonly setTitleDraft: (value: string) => void;
  readonly handleStartTitleEdit: () => void;
  readonly handleCancelTitleEdit: () => void;
  readonly handleSaveTitle: () => void;
  /** ticketId 切り替え時のフルリセット (resetFormState から呼ぶ)。 */
  readonly reset: () => void;
}

export function useTicketTitleEditing(
  ticketId: string,
  currentTitle: string | undefined,
): TicketTitleEditing {
  const queryClient = useQueryClient();
  const [titleEditing, setTitleEditing] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const [expectedCurrentTitle, setExpectedCurrentTitle] = useState('');

  const updateTitleMutation = useMutation({
    mutationFn: async () => {
      await patchTicketTitle(ticketId, titleDraft.trim(), expectedCurrentTitle);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['ticket', ticketId] });
      await queryClient.invalidateQueries({ queryKey: ['board'] });
      setTitleEditing(false);
      setTitleDraft('');
      setExpectedCurrentTitle('');
    },
    onError: async (error) => {
      if (error instanceof ApiError && error.status === 409) {
        await queryClient.invalidateQueries({ queryKey: ['ticket', ticketId] });
        setTitleEditing(false);
        setTitleDraft('');
        setExpectedCurrentTitle('');
      }
    },
  });

  const trimmedTitleDraft = titleDraft.trim();
  const canSaveTitle =
    trimmedTitleDraft.length > 0 && trimmedTitleDraft !== expectedCurrentTitle;

  const handleStartTitleEdit = useCallback(() => {
    if (currentTitle === undefined) {
      return;
    }
    setTitleDraft(currentTitle);
    setExpectedCurrentTitle(currentTitle);
    setTitleEditing(true);
  }, [currentTitle]);

  const handleCancelTitleEdit = useCallback(() => {
    setTitleEditing(false);
    setTitleDraft('');
    setExpectedCurrentTitle('');
  }, []);

  const handleSaveTitle = useCallback(() => {
    if (!canSaveTitle || updateTitleMutation.isPending) {
      return;
    }
    updateTitleMutation.mutate();
  }, [canSaveTitle, updateTitleMutation]);

  const reset = useCallback(() => {
    setTitleEditing(false);
    setTitleDraft('');
    setExpectedCurrentTitle('');
  }, []);

  return {
    titleEditing,
    titleDraft,
    canSaveTitle,
    isSaving: updateTitleMutation.isPending,
    error: updateTitleMutation.error,
    setTitleDraft,
    handleStartTitleEdit,
    handleCancelTitleEdit,
    handleSaveTitle,
    reset,
  };
}
