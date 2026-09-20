// bdboard-sso1.5 (PR-L): TicketDetailPanel.tsx の「human decision 回答」
// (質問への回答欄の state・送信 mutation・送信済み回答の保持・pendingDecision
// 切り替え時のリセット) を、挙動を変えずにこのカスタムフックへ抽出しただけの
// ファイル。useTicketQuickActions / useTicketAgentRun と同じ抽出パターン。
//
// submittedDecision はチケット詳細の commentsEnabled 算出 (コメント欄をいつ
// 取得するか) にも使われている。元の実装がまさにこの2つ(コメント数 / 回答済み
// フラグ)を1つの式で合成していたのと同じ形を、呼び出し元 (TicketDetailPanel)
// 側で submittedDecision を読んで再現している — このフックはコメント欄の
// ことを一切知らない。
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
import {
  postTicketDecision,
  type PendingDecisionDto,
} from '../../api';
import type { SubmittedDecision } from './types';

export function useTicketDecisionAnswer(
  ticketId: string,
  pendingDecision: PendingDecisionDto | undefined,
) {
  const queryClient = useQueryClient();

  const [submittedDecision, setSubmittedDecision] =
    useState<SubmittedDecision | null>(null);
  const [selectedChoice, setSelectedChoice] = useState<string | undefined>(
    undefined,
  );
  const [freeformText, setFreeformText] = useState('');

  // 質問への回答欄だけを初期化する。reset はこれを含む全体リセット。
  const resetDecisionAnswer = useCallback(() => {
    setSelectedChoice(undefined);
    setFreeformText('');
  }, []);

  const trimmedFreeform = freeformText.trim();
  const canSubmitDecision =
    selectedChoice !== undefined || trimmedFreeform.length > 0;

  const decisionMutation = useMutation({
    mutationFn: async () => {
      if (pendingDecision === undefined) {
        throw new Error('pending decision is not available');
      }

      return postTicketDecision(pendingDecision.id, {
        ...(selectedChoice !== undefined ? { choice: selectedChoice } : {}),
        ...(trimmedFreeform.length > 0 ? { freeform: trimmedFreeform } : {}),
      });
    },
    onSuccess: async (outcome) => {
      if (pendingDecision !== undefined) {
        const choiceLabel =
          selectedChoice !== undefined
            ? pendingDecision.options?.find(
                (option) => option.value === selectedChoice,
              )?.label
            : undefined;
        setSubmittedDecision({
          decisionId: pendingDecision.id,
          outcome,
          ...(choiceLabel !== undefined ? { choiceLabel } : {}),
          ...(trimmedFreeform.length > 0 ? { freeform: trimmedFreeform } : {}),
        });
      }
      await queryClient.invalidateQueries({ queryKey: ['ticket', ticketId] });
      await queryClient.invalidateQueries({ queryKey: ['pending-decisions'] });
      await queryClient.invalidateQueries({
        queryKey: ['ticket-comments', ticketId],
      });
      setSelectedChoice(undefined);
      setFreeformText('');
    },
  });

  // submittedDecision は pendingDecision 切り替えでは消さない。回答直後に
  // 「送信した回答」セクションが消えると bdboard-50n の元バグに戻るため。
  //
  // ここで消すのは *この質問への回答欄だけ*。pendingDecision はポーリング由来で、
  // 利用者が何もしていなくても出現/消滅する — フォーム全体を resetFormState() で
  // 消していたため、エージェントが質問を投稿した瞬間に書きかけのコメントや
  // クローズ理由が警告なく消えていた (bdboard-9hl)。チケット自体が変わったときの
  // 全体リセットは呼び出し元の reset({ clearSubmittedDecision: true }) が担当する。
  //
  // 送信ミューテーションの状態もここで捨てる。質問1の送信に失敗したあと
  // エージェントが質問1を取り下げて質問2を出すと、質問2の送信ボタンの下に
  // 質問1の失敗メッセージが残り続けていた (bdboard-uez)。id が変わったときだけ
  // 消すので、「失敗したが質問は同じまま」ではメッセージは残る。
  const resetDecision = decisionMutation.reset;
  useEffect(() => {
    resetDecisionAnswer();
    resetDecision();
  }, [pendingDecision?.id, resetDecisionAnswer, resetDecision]);

  /** ticketId 切り替え時のフルリセット (resetFormState から呼ぶ)。 */
  const reset = useCallback(
    (options?: { clearSubmittedDecision?: boolean }) => {
      resetDecisionAnswer();
      if (options?.clearSubmittedDecision === true) {
        setSubmittedDecision(null);
      }
    },
    [resetDecisionAnswer],
  );

  return {
    submittedDecision,
    selectedChoice,
    setSelectedChoice,
    freeformText,
    setFreeformText,
    canSubmitDecision,
    decisionMutation,
    reset,
  };
}
