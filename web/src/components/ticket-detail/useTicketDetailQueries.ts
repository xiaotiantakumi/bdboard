// bdboard-sso1.5: useTicketDetailController.ts の前半 — チケット本体・コメント数・
// 変更履歴・似ているチケット・着手中重複チケットの4つの useQuery と、決定回答
// フック (useTicketDecisionAnswer) をまとめた。useTicketDetailController.ts が
// 単独で ESLint の200行上限を超えるため2ファイルに分けただけで、フックの呼び出し
// 順序は変えていない — queryClient/undoSnackbar をここで先に確定させて返すのも、
// 元の TicketDetailPanel 本体で「この2つが一番最初に呼ばれていた」順序をそのまま
// 保つため(useTicketDetailController.ts 側で必要になるのは後半だが、呼び出し
// 位置は元の位置=ここに残す)。
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import {
  fetchTicket,
  fetchTicketComments,
  fetchTicketTimeline,
  fetchSimilarTickets,
  fetchTicketInFlightOverlaps,
  type PendingDecisionDto,
} from '../../api';
import { useUndoSnackbar } from '../UndoSnackbar';
import { useTicketDecisionAnswer } from './useTicketDecisionAnswer';

export interface UseTicketDetailQueriesParams {
  ticketId: string;
  projectRootPaths: ReadonlyMap<string, string>;
  pendingDecision: PendingDecisionDto | undefined;
  onTicketViewed?: (entry: { id: string; title: string; projectId: string }) => void;
}

export function useTicketDetailQueries({
  ticketId,
  projectRootPaths,
  pendingDecision,
  onTicketViewed,
}: UseTicketDetailQueriesParams) {
  const queryClient = useQueryClient();
  const undoSnackbar = useUndoSnackbar();
  const { data, isLoading, error } = useQuery({
    queryKey: ['ticket', ticketId],
    queryFn: () => fetchTicket(ticketId),
  });

  useEffect(() => {
    if (data === undefined) {
      return;
    }
    onTicketViewed?.({
      id: data.id,
      title: data.title,
      projectId: data.projectId,
    });
  }, [data?.id, data?.title, data?.projectId, onTicketViewed]);

  // agentRun (useTicketDetailController 側) の ticketId/projectRootPath 変更
  // リセットが内部の同期effectより先に走る順序を保証するため、agentRun 呼び出しより
  // 前で確定させておく (bdboard-sso1.5 PR-L Opus レビュー対応、
  // useTicketAgentRun.ts 冒頭コメント参照)。
  const projectRootPath =
    data === undefined ? undefined : projectRootPaths.get(data.projectId);

  const decision = useTicketDecisionAnswer(ticketId, pendingDecision);
  const commentsEnabled =
    data !== undefined &&
    (data.commentCount > 0 || decision.submittedDecision !== null);
  const {
    data: comments,
    isLoading: commentsLoading,
    error: commentsError,
  } = useQuery({
    queryKey: ['ticket-comments', ticketId],
    queryFn: () => fetchTicketComments(ticketId),
    enabled: commentsEnabled,
  });
  const [timelineExpanded, setTimelineExpanded] = useState(false);
  const {
    data: timelineEvents,
    isLoading: timelineLoading,
    error: timelineError,
  } = useQuery({
    queryKey: ['ticket-timeline', ticketId],
    queryFn: () => fetchTicketTimeline(ticketId),
    enabled: timelineExpanded,
  });
  const {
    data: similarTickets,
    isLoading: similarTicketsLoading,
    error: similarTicketsError,
  } = useQuery({
    queryKey: ['similar-tickets', ticketId],
    queryFn: () => fetchSimilarTickets(ticketId),
  });
  // 着手中チケット同士のファイル重複 (npm run drift の「着手中版」)。worktree で git を
  // 叩くので、closed のチケットでは最初から引かない (サーバー側も closed は返さない)。
  const inFlightOverlapsEnabled = data !== undefined && data.status !== 'closed';
  // 読み込み中フラグは使わない。到着するまで節ごと描かないので (見出しが一瞬出て
  // 消えるのを避ける)、data === undefined がそのまま「まだ出さない」を意味する。
  const { data: inFlightOverlaps, error: inFlightOverlapsError } = useQuery({
    queryKey: ['ticket-in-flight-overlaps', ticketId],
    queryFn: () => fetchTicketInFlightOverlaps(ticketId),
    enabled: inFlightOverlapsEnabled,
  });

  return {
    queryClient,
    undoSnackbar,
    data,
    isLoading,
    error,
    projectRootPath,
    decision,
    comment: { commentsEnabled, comments, commentsLoading, commentsError },
    timeline: {
      timelineExpanded,
      setTimelineExpanded,
      timelineEvents,
      timelineLoading,
      timelineError,
    },
    similarTickets: { similarTickets, similarTicketsLoading, similarTicketsError },
    inFlightOverlaps: { inFlightOverlapsEnabled, inFlightOverlaps, inFlightOverlapsError },
  };
}
