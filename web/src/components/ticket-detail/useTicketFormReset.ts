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
// 呼び出し位置の制約: このフックの引数(各セクションフックの reset)は呼び出し元
// (useTicketDetailController)側で先に宣言されている必要があるため、各セクションのフック
// (title/description/labels/dependencies/comment/
// decision)を呼び出した後でしか呼べない(TDZ)。それより後ろへ動かすこと自体は
// 型上は可能だが、元の resetFormState useEffect があった位置(useFocusTrap の
// 直前)からは動かさないこと — React の effect 実行順は「レンダー中にどの位置で
// 呼ばれたか」で決まるため、動かすと他の effect との相対順序が変わりうる。
// 不変条件は「このフック内の reset の呼び出し順」と「useEffect の依存配列の中身」。
import { useCallback, useEffect } from 'react';

export interface UseTicketFormResetParams {
  readonly ticketId: string;
  readonly projectRootPath: string | undefined;
  readonly resetDecision: (options?: {
    clearSubmittedDecision?: boolean;
  }) => void;
  readonly resetComment: () => void;
  readonly resetDependencies: () => void;
  readonly resetLabelInput: () => void;
  readonly resetTitleEditing: () => void;
  readonly resetDescriptionEditing: () => void;
}

/**
 * ticketId または projectRootPath が変わるたびに、各セクションのフォーム
 * 下書き・確認ダイアログ・エラー表示を、元の resetFormState と同じ順序で
 * 一括リセットする。
 *
 * 戻り値は無い(副作用のみ)。抽出前の resetFormState も、ticketId 変更
 * useEffect 以外から呼ばれてはいなかった(呼び出し箇所はこの1つだけだった)ため、
 * 公開する意味のある戻り値が無い。将来、手動リセットが必要になったら
 * 戻り値として公開すること。
 */
export function useTicketFormReset({
  ticketId,
  projectRootPath,
  resetDecision,
  resetComment,
  resetDependencies,
  resetLabelInput,
  resetTitleEditing,
  resetDescriptionEditing,
}: UseTicketFormResetParams): void {
  const resetFormState = useCallback(
    (options?: { clearSubmittedDecision?: boolean }) => {
      resetDecision({
        clearSubmittedDecision: options?.clearSubmittedDecision === true,
      });
      resetComment();
      resetDependencies();
      resetLabelInput();
      resetTitleEditing();
      resetDescriptionEditing();
    },
    [
          resetDecision,
          resetComment,
      resetDependencies,
      resetDescriptionEditing,
      resetLabelInput,
          resetTitleEditing,
    ],
  );

  useEffect(() => {
    resetFormState({ clearSubmittedDecision: true });
  }, [ticketId, projectRootPath, resetFormState]);
}
