// bdboard-sso1.5 (PR-L): TicketDetailPanel.tsx の「human decision 回答」
// (質問への回答欄の state・送信 mutation・送信済み回答の保持・pendingDecision
// 切り替え時のリセット) を、挙動を変えずにこのカスタムフックへ抽出しただけの
// ファイル。他の ticket-detail フックと同じ抽出パターン。
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
  type BoardDto,
  type BoardViewDto,
  type PendingDecisionDto,
} from '../../api';
import type { SubmittedDecision } from './types';

/** bdboard-aob1: 「OK」ボタンなど、入力欄を介さず即送信する回答。 */
export interface QuickDecisionAnswer {
  freeform: string;
}

/** bdboard-zjw2: 回答成功後のトースト本文に出す回答文の最大長。 */
const TOAST_ANSWER_MAX = 30;

export interface UseTicketDecisionAnswerOptions {
  /** 回答が確認待ちを解消したとき、詳細パネルを閉じてボードへ戻す。 */
  onClose?: () => void;
  /** 回答済みの通知を出す。「開く」で回答したチケットを開き直せる。 */
  notify?:
    | ((
        message: string,
        action?: { label: string; onClick: () => void },
      ) => void)
    | undefined;
  onOpenTicket?: (ticketId: string) => void;
}

function truncateAnswer(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > TOAST_ANSWER_MAX
    ? `${oneLine.slice(0, TOAST_ANSWER_MAX)}…`
    : oneLine;
}

function dropAwaitingHumanCards(
  board: BoardDto,
  ids: ReadonlySet<string>,
): BoardDto {
  const lane = board.lanes['awaiting_human'];
  if (lane === undefined || !lane.some((card) => ids.has(card.ticket.id))) {
    return board;
  }
  const kept = lane.filter((card) => !ids.has(card.ticket.id));
  return {
    ...board,
    lanes: { ...board.lanes, awaiting_human: kept },
    cardCount: board.cardCount - (lane.length - kept.length),
  };
}

export function useTicketDecisionAnswer(
  ticketId: string,
  pendingDecision: PendingDecisionDto | undefined,
  options: UseTicketDecisionAnswerOptions = {},
) {
  const { onClose, onOpenTicket, notify } = options;
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
    mutationFn: async (quick?: QuickDecisionAnswer) => {
      if (pendingDecision === undefined) {
        throw new Error('pending decision is not available');
      }

      // bdboard-aob1: 「OK」ワンタップは入力欄・選択肢を使わず freeform だけを送る。
      if (quick !== undefined) {
        return postTicketDecision(pendingDecision.id, { freeform: quick.freeform });
      }
      return postTicketDecision(pendingDecision.id, {
        ...(selectedChoice !== undefined ? { choice: selectedChoice } : {}),
        ...(trimmedFreeform.length > 0 ? { freeform: trimmedFreeform } : {}),
      });
    },
    onSuccess: async (outcome, quick) => {
      if (pendingDecision !== undefined) {
        const sentChoice = quick === undefined ? selectedChoice : undefined;
        const sentFreeform =
          quick !== undefined ? quick.freeform : trimmedFreeform;
        const choiceLabel =
          sentChoice !== undefined
            ? pendingDecision.options?.find(
                (option) => option.value === sentChoice,
              )?.label
            : undefined;
        setSubmittedDecision({
          decisionId: pendingDecision.id,
          outcome,
          ...(choiceLabel !== undefined ? { choiceLabel } : {}),
          ...(sentFreeform.length > 0 ? { freeform: sentFreeform } : {}),
        });

        // bdboard-zjw2: 確認待ちが実際に解消した (どの gate も取りこぼしていない)
        // ときだけ、カードを確認待ちレーンから即座に外し、パネルを閉じる。
        // ambiguous / unknown は何も resolve していないので、パネルを残して
        // 「送信した回答」の説明を読ませる。
        const resolved =
          outcome.kind !== 'unknown' &&
          (outcome.ambiguousGateIds === undefined ||
            outcome.ambiguousGateIds.length === 0);
        if (resolved) {
          const dropIds = new Set<string>([
            pendingDecision.id,
            ...(outcome.clearedHumanLabelTicketIds ?? []),
          ]);
          queryClient.setQueriesData<BoardViewDto>(
            { queryKey: ['board'] },
            (old) =>
              old === undefined
                ? old
                : {
                    ...old,
                    merged:
                      old.merged === null
                        ? null
                        : dropAwaitingHumanCards(old.merged, dropIds),
                    projects: old.projects.map((entry) => ({
                      ...entry,
                      board: dropAwaitingHumanCards(entry.board, dropIds),
                    })),
                  },
          );
          queryClient.setQueryData<PendingDecisionDto[]>(
            ['pending-decisions'],
            (old) => old?.filter((decision) => decision.id !== pendingDecision.id),
          );
          const answerText = sentFreeform.length > 0 ? sentFreeform : (choiceLabel ?? sentChoice);
          const message =
            answerText !== undefined && answerText.length > 0
              ? `${ticketId} に「${truncateAnswer(answerText)}」と回答`
              : `${ticketId} に回答しました`;
          notify?.(
            message,
            onOpenTicket !== undefined
              ? { label: '開く', onClick: () => onOpenTicket(ticketId) }
              : undefined,
          );
          onClose?.();
        }
      }
      await queryClient.invalidateQueries({ queryKey: ['board'] });
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
  //
  // この effect が decisionMutation の下にあるのは、deps 配列が描画中に
  // 評価されるため。上に置くと decisionMutation が TDZ で ReferenceError になる。
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
