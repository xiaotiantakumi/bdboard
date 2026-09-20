// bdboard-sso1.5 (PR-E): TicketDetailPanel.tsx の「ラベル編集」に関する
// state + mutation + handler 一式を、挙動を変えずにこのカスタムフックへ抽出
// しただけのファイル。useTicketTitleEditing / useTicketDescriptionEditing と
// 同じ抽出パターン。呼び出し順序・依存配列・queryKey・onSuccess の中身は
// 移動前から変えていない。
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';
import { deleteTicketLabel, postTicketAddLabel } from '../../api';

export interface TicketLabelsEditing {
  readonly labelInputQuery: string;
  readonly setLabelInputQuery: (value: string) => void;
  readonly trimmedLabelInput: string;
  readonly labelSuggestions: string[];
  readonly canSubmitLabel: boolean;
  readonly labelMutationPending: boolean;
  readonly isAddPending: boolean;
  readonly error: unknown;
  readonly handleAddLabel: (label: string) => void;
  readonly handleRemoveLabel: (label: string) => void;
  /** ticketId 切り替え時のフルリセット (resetFormState から呼ぶ)。 */
  readonly reset: () => void;
}

export function useTicketLabels(
  ticketId: string,
  currentLabels: readonly string[],
  availableLabels: readonly string[],
): TicketLabelsEditing {
  const queryClient = useQueryClient();
  const [labelInputQuery, setLabelInputQuery] = useState('');

  const addLabelMutation = useMutation({
    mutationFn: async (label: string) => {
      await postTicketAddLabel(ticketId, label);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['ticket', ticketId] });
      await queryClient.invalidateQueries({ queryKey: ['board'] });
      setLabelInputQuery('');
    },
  });

  const removeLabelMutation = useMutation({
    mutationFn: async (label: string) => {
      await deleteTicketLabel(ticketId, label);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['ticket', ticketId] });
      await queryClient.invalidateQueries({ queryKey: ['board'] });
    },
  });

  const labelMutationPending =
    addLabelMutation.isPending || removeLabelMutation.isPending;
  const labelMutationError = addLabelMutation.error ?? removeLabelMutation.error;

  const trimmedLabelInput = labelInputQuery.trim();
  const labelSuggestions = availableLabels
    .filter((label) => !currentLabels.includes(label))
    .filter(
      (label) =>
        trimmedLabelInput.length === 0 ||
        label.toLowerCase().includes(trimmedLabelInput.toLowerCase()),
    )
    .slice(0, 20);
  const canSubmitLabel =
    trimmedLabelInput.length > 0 && !currentLabels.includes(trimmedLabelInput);

  const handleAddLabel = useCallback(
    (label: string) => {
      const trimmed = label.trim();
      if (trimmed.length === 0 || currentLabels.includes(trimmed)) {
        return;
      }
      addLabelMutation.mutate(trimmed);
    },
    [addLabelMutation, currentLabels],
  );

  const handleRemoveLabel = useCallback(
    (label: string) => {
      removeLabelMutation.mutate(label);
    },
    [removeLabelMutation],
  );

  const reset = useCallback(() => {
    setLabelInputQuery('');
  }, []);

  return {
    labelInputQuery,
    setLabelInputQuery,
    trimmedLabelInput,
    labelSuggestions,
    canSubmitLabel,
    labelMutationPending,
    isAddPending: addLabelMutation.isPending,
    error: labelMutationError,
    handleAddLabel,
    handleRemoveLabel,
    reset,
  };
}
