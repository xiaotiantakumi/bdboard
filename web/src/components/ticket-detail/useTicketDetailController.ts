// bdboard-sso1.5: TicketDetailPanel.tsx の本体(旧89箇所のフック呼び出しのうち、
// パネル外枠(resize-handle/header呼び出し・'c'ショートカットのdisabled合成に
// 必要な最小限を除く)を1つの組み立てフックへ集約した。前半(4つの useQuery +
// 決定回答フック)は行数上限のため useTicketDetailQueries.ts に分けたが、
// フックの呼び出し順・useEffect の依存配列は元の TicketDetailPanel 本体
// (旧94〜346行目)から一切変えていない — このファイルの宣言順は
// useTicketDetailQueries が返した時点より後ろの元コンポーネントの宣言順と
// 完全に同じ。
//
// 不変条件(壊すと壊れるもの):
// - useTicketFormReset は各セクションの reset を使うため、それらのフック呼び出し
//   より後でしか呼べない(TDZ)。かつ useFocusTrap の直前という元の位置を維持する
//   こと(useTicketFormReset.ts 冒頭コメント参照。この制約は元の並びをそのまま
//   保っているだけで、今回変更していない)。
//
// 戻り値はセクションの関心事ごとにグループ化して返す
// (title/description/labels/dependencies/comment/timeline/
// similarTickets/inFlightOverlaps/decision)。
// 各グループの中身は対応するフックの戻り値オブジェクトをそのまま(または
// 表示に必要な派生値を足して spread した)もので、フィールド名は元の
// TicketDetailPanel 内のローカル変数名/フックの戻り値フィールド名を変えていない。
import { useEffect, useRef, type RefObject } from 'react';
import { type PendingDecisionDto } from '../../api';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { useTicketDetailQueries } from './useTicketDetailQueries';
import { useTicketTitleEditing } from './useTicketTitleEditing';
import { useTicketDescriptionEditing } from './useTicketDescriptionEditing';
import { useTicketLabels } from './useTicketLabels';
import { useTicketDependencies } from './useTicketDependencies';
import { useTicketComment } from './useTicketComment';
import { useTicketFormReset } from './useTicketFormReset';
import { useCommentFocusShortcut } from './useCommentFocusShortcut';

export interface UseTicketDetailControllerParams {
  ticketId: string;
  projectRootPaths: ReadonlyMap<string, string>;
  pendingDecision: PendingDecisionDto | undefined;
  onClose: () => void;
  onTicketViewed?: (entry: { id: string; title: string; projectId: string }) => void;
  availableLabels?: readonly string[];
  /**
   * パネル/セクション横断で共有する ref はここで受け取る (呼び出し元の
   * TicketDetailPanel が useRef で生成して渡す)。react-hooks/refs lint が
   * 「ref を他のデータと同じオブジェクトに束ねて返す」パターンを
   * render中のref誤読み取りとみなして誤検知するため、このフックの戻り値には
   * 含めない (bdboard-sso1.5 このPRで対応)。
   */
  panelRef: RefObject<HTMLDivElement | null>;
  closeButtonRef: RefObject<HTMLButtonElement | null>;
  commentTextareaRef: RefObject<HTMLTextAreaElement | null>;
}

export function useTicketDetailController({
  ticketId,
  projectRootPaths,
  pendingDecision,
  onClose,
  onTicketViewed,
  availableLabels = [],
  panelRef,
  closeButtonRef,
  commentTextareaRef,
}: UseTicketDetailControllerParams) {
  const queries = useTicketDetailQueries({
    ticketId,
    projectRootPaths,
    pendingDecision,
    onTicketViewed,
  });
  const { queryClient, data, isLoading, error, projectRootPath, decision } =
    queries;

  const title = useTicketTitleEditing(ticketId, data?.title);
  const description = useTicketDescriptionEditing(
    ticketId,
    data !== undefined,
    data?.description,
  );
  const currentLabels = data?.labels ?? [];
  const labels = useTicketLabels(ticketId, currentLabels, availableLabels);
  const dependencies = useTicketDependencies(ticketId, data);
  const comment = useTicketComment(ticketId);
  const prevCommentCountRef = useRef<number | undefined>(undefined);

  // ticketId/projectRootPath 変更時の各セクション横断リセットは
  // useTicketFormReset.ts に抽出済み (bdboard-sso1.5)。
  useTicketFormReset({
    ticketId,
    projectRootPath,
    resetDecision: decision.reset,
    resetComment: comment.reset,
    resetDependencies: dependencies.reset,
    resetLabelInput: labels.reset,
    resetTitleEditing: title.reset,
    resetDescriptionEditing: description.reset,
  });

  useFocusTrap({
    containerRef: panelRef,
    initialFocusRef: closeButtonRef,
    onEscape: onClose,
    enabled: true,
  });

  // パネル外枠の 'c' キーボードショートカット (コメント入力欄へフォーカス)。
  // useTicketFormReset と同じく、disabled の中身  は複数セクションのフックを跨ぐため、合成は親側に残す。
  const onCommentFocusShortcut = useCommentFocusShortcut({
    textareaRef: commentTextareaRef,
    disabled: false,
  });

  useEffect(() => {
    const commentCount = data?.commentCount;
    const prevCommentCount = prevCommentCountRef.current;
    prevCommentCountRef.current = commentCount;

    if (
      prevCommentCount !== undefined &&
      commentCount !== undefined &&
      prevCommentCount !== commentCount
    ) {
      void queryClient.invalidateQueries({
        queryKey: ['ticket-comments', ticketId],
      });
    }
  }, [data?.commentCount, queryClient, ticketId]);


  return {
    data,
    isLoading,
    error,
    projectRootPath,
    title,
    description,
    labels: { currentLabels, ...labels },
    dependencies,
    comment: { ...queries.comment, ...comment },
    timeline: queries.timeline,
    similarTickets: queries.similarTickets,
    inFlightOverlaps: queries.inFlightOverlaps,
    decision,
    onCommentFocusShortcut,
  };
}
