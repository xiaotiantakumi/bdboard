// bdboard-sso1.5 (PR-J): TicketDetailPanel.tsx の「セッションリンク」編集に
// 関する state + query + mutation 一式を、挙動を変えずにこのカスタムフックへ
// 抽出しただけのファイル。useTicketLabels.ts / useTicketDependencies.ts と
// 同じ抽出パターン。呼び出し順序・依存配列・queryKey・onSuccess の中身は
// 移動前から変えていない。
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';
import {
  deleteTicketSessionLink,
  fetchSessions,
  postTicketSessionLink,
} from '../../api';

export function useTicketSessionLink(ticketId: string) {
  const queryClient = useQueryClient();
  const [sessionLinkPickerOpen, setSessionLinkPickerOpen] = useState(false);

  // 'sessions' クエリキーは SessionListPanel と共有している(同じアクティブ
  // セッション一覧なので、既存キャッシュがあれば流用できる)。
  const activeSessionsQuery = useQuery({
    queryKey: ['sessions'],
    queryFn: fetchSessions,
    enabled: sessionLinkPickerOpen,
  });

  const linkSessionMutation = useMutation({
    mutationFn: async (sessionId: string) => {
      await postTicketSessionLink(ticketId, sessionId);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['ticket', ticketId] });
      setSessionLinkPickerOpen(false);
    },
  });

  const unlinkSessionMutation = useMutation({
    mutationFn: async () => {
      await deleteTicketSessionLink(ticketId);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['ticket', ticketId] });
    },
  });

  const sessionLinkMutationPending =
    linkSessionMutation.isPending || unlinkSessionMutation.isPending;
  const sessionLinkMutationError =
    linkSessionMutation.error ?? unlinkSessionMutation.error;
  const activeSessionCandidates = (activeSessionsQuery.data ?? []).filter(
    (session) => session.alive,
  );

  const togglePicker = useCallback(() => {
    setSessionLinkPickerOpen((open) => !open);
  }, []);

  const reset = useCallback(() => {
    setSessionLinkPickerOpen(false);
  }, []);

  return {
    sessionLinkPickerOpen,
    togglePicker,
    isLoadingSessions: activeSessionsQuery.isLoading,
    activeSessionCandidates,
    sessionLinkMutationPending,
    sessionLinkMutationError,
    onLinkSession: (sessionId: string) => linkSessionMutation.mutate(sessionId),
    onUnlinkSession: () => unlinkSessionMutation.mutate(),
    reset,
  };
}
