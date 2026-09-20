// bdboard-sso1.5 (PR-D): TicketDetailPanel.tsx の「Description編集」に関する
// state + mutation + handler 一式を、挙動を変えずにこのカスタムフックへ抽出
// しただけのファイル。useTicketTitleEditing と同じ抽出パターン。呼び出し
// 順序・依存配列・queryKey・onSuccess/onError の中身は移動前から変えていない。
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';
import { ApiError, patchTicketDescription } from '../../api';

export interface TicketDescriptionEditing {
  readonly descriptionEditing: boolean;
  readonly descriptionDraft: string;
  readonly canSaveDescription: boolean;
  readonly isSaving: boolean;
  readonly error: unknown;
  readonly setDescriptionDraft: (value: string) => void;
  readonly handleStartDescriptionEdit: () => void;
  readonly handleCancelDescriptionEdit: () => void;
  readonly handleSaveDescription: () => void;
  /** ticketId 切り替え時のフルリセット (resetFormState から呼ぶ)。 */
  readonly reset: () => void;
}

export function useTicketDescriptionEditing(
  ticketId: string,
  /** data !== undefined (元実装の早期リターン条件)。 */
  hasData: boolean,
  currentDescription: string | undefined,
): TicketDescriptionEditing {
  const queryClient = useQueryClient();
  const [descriptionEditing, setDescriptionEditing] = useState(false);
  const [descriptionDraft, setDescriptionDraft] = useState('');
  const [expectedCurrentDescription, setExpectedCurrentDescription] =
    useState('');

  const updateDescriptionMutation = useMutation({
    mutationFn: async () => {
      await patchTicketDescription(
        ticketId,
        descriptionDraft,
        expectedCurrentDescription,
      );
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['ticket', ticketId] });
      setDescriptionEditing(false);
      setDescriptionDraft('');
      setExpectedCurrentDescription('');
    },
    onError: async (error) => {
      if (error instanceof ApiError && error.status === 409) {
        await queryClient.invalidateQueries({ queryKey: ['ticket', ticketId] });
        setDescriptionEditing(false);
        setDescriptionDraft('');
        setExpectedCurrentDescription('');
      }
    },
  });

  const handleStartDescriptionEdit = useCallback(() => {
    if (!hasData) {
      return;
    }
    const current = currentDescription ?? '';
    setDescriptionDraft(current);
    setExpectedCurrentDescription(current);
    setDescriptionEditing(true);
  }, [hasData, currentDescription]);

  const handleCancelDescriptionEdit = useCallback(() => {
    setDescriptionEditing(false);
    setDescriptionDraft('');
    setExpectedCurrentDescription('');
  }, []);

  const handleSaveDescription = useCallback(() => {
    if (
      descriptionDraft === expectedCurrentDescription ||
      updateDescriptionMutation.isPending
    ) {
      return;
    }
    updateDescriptionMutation.mutate();
  }, [
    descriptionDraft,
    expectedCurrentDescription,
    updateDescriptionMutation,
  ]);

  const reset = useCallback(() => {
    setDescriptionEditing(false);
    setDescriptionDraft('');
    setExpectedCurrentDescription('');
  }, []);

  return {
    descriptionEditing,
    descriptionDraft,
    canSaveDescription:
      descriptionDraft !== expectedCurrentDescription,
    isSaving: updateDescriptionMutation.isPending,
    error: updateDescriptionMutation.error,
    setDescriptionDraft,
    handleStartDescriptionEdit,
    handleCancelDescriptionEdit,
    handleSaveDescription,
    reset,
  };
}
