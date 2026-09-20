// bdboard-sso1.5 (PR-I): TicketDetailPanel.tsx の「コメント投稿」に関する
// state + mutation 一式を、挙動を変えずにこのカスタムフックへ抽出しただけの
// ファイル。useTicketTitleEditing.ts / useTicketDescriptionEditing.ts と
// 同じ抽出パターン。queryKey・onSuccess の中身は移動前から変えていない。
// フック呼び出しの位置だけは、resetFormState の依存配列がこのフックの
// reset を参照するようになったため、他の useTicket*Editing/useTicketLabels/
// useTicketDependencies と同じく resetFormState 定義より前へ動かしている
// (元の位置のままだと reset が TDZ で参照エラーになる)。textarea への ref
// (commentTextareaRef) は「c キーでフォーカス」ショートカットが親側のパネル
// 全体の keydown ハンドラに同居しているため、親に残す。
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';
import { postTicketComment } from '../../api';

export function useTicketComment(ticketId: string) {
  const queryClient = useQueryClient();
  const [commentText, setCommentText] = useState('');
  const trimmedCommentText = commentText.trim();
  const canSubmitComment = trimmedCommentText.length > 0;

  const commentMutation = useMutation({
    mutationFn: async () => {
      await postTicketComment(ticketId, trimmedCommentText);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['ticket', ticketId] });
      await queryClient.invalidateQueries({
        queryKey: ['ticket-comments', ticketId],
      });
      setCommentText('');
    },
  });

  const reset = useCallback(() => {
    setCommentText('');
  }, []);

  return {
    commentText,
    setCommentText,
    canSubmitComment,
    mutation: commentMutation,
    reset,
  };
}
