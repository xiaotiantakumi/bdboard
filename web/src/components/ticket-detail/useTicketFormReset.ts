// bdboard-sso1.5: TicketDetailPanel.tsx の「チケット切り替え(ticketId/
// projectRootPath 変更)時に各セクションのフォーム下書き・確認ダイアログ・
// エラー表示をまとめてリセットする」横断的な組み立て(旧 resetFormState +
// それを呼ぶ useEffect)を、挙動を変えずにこのカスタムフックへ抽出した。
//
// useReducer 化はしていない: resetFormState は「複数の下位フックの reset()
// を決まった順で呼ぶだけ」の薄い合成で、状態そのものの遷移が複雑なわけではない
// (各状態は既に個別の use-hook が持っている)。不変条件は「呼び出し順序」と
// 「useEffect の依存配列の中身」であり、これは素のカスタムフックのまま
// テストできる。
//
// 含めないもの: agentRun (useTicketAgentRun) の reset。PR-L の Opus レビューで
// 見つかった不具合 (c9fcb38) により、agentRun は ticketId/projectRootPath 変更の
// リセットを自前の useEffect として内部に持つようになった。ここから重ねて
// 呼ぶと、キャッシュ済みの実行中 run の復元を再びリセットで巻き戻してしまう。
// このフックは今後も agentRun には一切触れないこと。
//
// 呼び出し位置の制約: React の effect 実行順は「レンダー中にどの位置でこの
// フックが呼ばれたか」で決まる。呼び出し元 (TicketDetailPanel) では、各
// セクションのフック (title/description/labels/dependencies/comment/
// sessionLink/quickActions/decision) を呼び出した後、元の resetFormState
// useEffect があった位置と同じ場所でこのフックを呼ぶこと。位置を動かすと
// 「まず各下書きをリセット→その後に復元処理が走る」という宣言順に基づく
// 順序保証(bdboard-sso1.5 PR-L のコメント参照)が壊れうる。
import { useCallback, useEffect } from 'react';

export interface UseTicketFormResetParams {
  readonly ticketId: string;
  readonly projectRootPath: string | undefined;
  readonly clearCopyDisplay: () => void;
  readonly resetDecision: (options?: {
    clearSubmittedDecision?: boolean;
  }) => void;
  readonly resetQuickActions: () => void;
  readonly resetComment: () => void;
  readonly resetDependencies: () => void;
  readonly resetLabelInput: () => void;
  readonly resetTitleEditing: () => void;
  readonly resetDescriptionEditing: () => void;
  readonly resetSessionLink: () => void;
}

/**
 * ticketId または projectRootPath が変わるたびに、各セクションのフォーム
 * 下書き・確認ダイアログ・エラー表示を、元の resetFormState と同じ順序で
 * 一括リセットする。
 *
 * 戻り値は無い(副作用のみ)。抽出前の resetFormState も、ticketId 変更
 * useEffect 以外から呼ばれてはいなかった(呼び出し箇所はこの1つだけだった)ため、
 * 公開する意味のある戻り値が無い。将来、手動リセットが必要になったら
 * useTicketAgentRun.reset と同様に戻り値として公開すること。
 */
export function useTicketFormReset({
  ticketId,
  projectRootPath,
  clearCopyDisplay,
  resetDecision,
  resetQuickActions,
  resetComment,
  resetDependencies,
  resetLabelInput,
  resetTitleEditing,
  resetDescriptionEditing,
  resetSessionLink,
}: UseTicketFormResetParams): void {
  const resetFormState = useCallback(
    (options?: { clearSubmittedDecision?: boolean }) => {
      clearCopyDisplay();
      resetDecision({
        clearSubmittedDecision: options?.clearSubmittedDecision === true,
      });
      resetQuickActions();
      resetComment();
      resetDependencies();
      resetLabelInput();
      resetTitleEditing();
      resetDescriptionEditing();
      resetSessionLink();
    },
    [
      clearCopyDisplay,
      resetDecision,
      resetQuickActions,
      resetComment,
      resetDependencies,
      resetDescriptionEditing,
      resetLabelInput,
      resetSessionLink,
      resetTitleEditing,
    ],
  );

  useEffect(() => {
    resetFormState({ clearSubmittedDecision: true });
  }, [ticketId, projectRootPath, resetFormState]);
}
