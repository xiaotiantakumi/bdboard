import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BD_COMMAND_DEFINITIONS,
  buildBdCommand,
  type BdCommandKind,
  copyTextToClipboard,
} from '../bdCommands';
import {
  deleteTicketDependency,
  ApiError,
  cancelAgentRun,
  deleteTicketLabel,
  deleteTicketSessionLink,
  fetchAgentRun,
  fetchProjectHarnessStatus,
  fetchSessions,
  fetchTicket,
  fetchTicketRuns,
  patchTicketDescription,
  patchTicketTitle,
  fetchTicketComments,
  fetchTicketTimeline,
  fetchSimilarTickets,
  fetchTicketInFlightOverlaps,
  postTicketComment,
  postTicketDecision,
  postTicketAddLabel,
  postTicketDependency,
  postTicketQuickAction,
  postTicketQuickActionUndo,
  postTicketSessionLink,
  searchTickets,
  startTicketRun,
  type AgentRunDetailDto,
  type AgentRunNextStepDto,
  type AgentRunSummaryDto,
  type PendingDecisionDto,
  type TicketDecisionOutcome,
  type PrBadgeDto,
  type QuickActionRequest,
  type SessionDto,
  type ActivityEventDto,
  type TicketDetailDto,
  type TicketSearchResultDto,
  type TicketInFlightOverlapDto,
  type TicketSimilarResultDto,
  LANE_LABELS,
} from '../api';
import { useAutoClearedValue } from '../hooks/useAutoClearedValue';
import { useFocusTrap } from '../hooks/useFocusTrap';
import {
  AGENT_RUN_POLL_INTERVAL_MS,
  AGENT_RUN_POLL_MAX_FAILURES,
  buildRunNextStepCommand,
  describeHarnessRunBlock,
  describeRunStartError,
  isAgentRunInProgress,
} from './agentRunShared';
import {
  SidePanelResizeHandle,
  useResizableSidePanel,
} from '../hooks/useResizableSidePanel';
import { formatAbsoluteTime } from '../formatAbsoluteTime';
import { UI_STORAGE_KEYS } from '../uiPersistedState';
import { describeWriteError } from '../writeAccessMessage';
import { planQuickActionUndo } from '../quickActionUndo';
import {
  describeDependencyError,
  filterDependencyCandidates,
} from './dependencyEditing';
import { MarkdownContent } from './MarkdownContent';
import { PlatformLimitationNotice } from './PlatformLimitationNotice';
import { PrLinkBadge } from './PrLinkBadge';
import { WatchToggle } from './WatchToggle';
import { useUndoSnackbar } from './UndoSnackbar';
import {
  ACTIVITY_KIND_LABELS,
  formatActivityTime,
  groupEventsByDate,
} from './activityFeedFormatting';
import {
  computeDeferUntilDate,
  DEFAULT_DEFER_PERIOD,
  DEFER_PERIOD_OPTIONS,
  isFutureLocalDate,
  todayLocalDateInputValue,
  type DeferPeriodKind,
} from '../deferPeriods';

const DEPENDENCY_SEARCH_DEBOUNCE_MS = 200;
const DEPENDENCY_SEARCH_LIMIT = 20;

/**
 * 「衝突しうる着手中チケット」で相手 1 件あたりに並べるファイル数の上限。
 * 大きく育ったブランチだと 100 件を超えることがあり、詳細パネルがファイル一覧で
 * 埋まって他の情報が押し出される。残りは件数だけ出す。
 */
const OVERLAP_FILE_DISPLAY_LIMIT = 20;

const COPY_FEEDBACK_MS = 2000;

function timelineKindBadgeClass(
  kind: ActivityEventDto['kind'],
): string {
  return `activity-kind-badge activity-kind-${kind}`;
}

function formatTimelineChangeDetail(
  kind: ActivityEventDto['kind'],
  from: string | undefined,
  to: string | undefined,
): string | undefined {
  if (
    (kind === 'status_changed' || kind === 'priority_changed') &&
    from !== undefined &&
    to !== undefined
  ) {
    return `${from} → ${to}`;
  }
  return undefined;
}

export interface TicketDetailPanelProps {
  ticketId: string;
  /**
   * projectId -> project root path. The panel resolves the path from the loaded
   * ticket's own projectId rather than from the board, so the generated
   * commands keep their `-C` even for tickets that are not on the board
   * (a parent or blocker outside the current filter, for instance).
   */
  projectRootPaths: ReadonlyMap<string, string>;
  pendingDecision: PendingDecisionDto | undefined;
  prLink?: PrBadgeDto;
  onClose: () => void;
  onChatAboutTicket?: (ctx: { projectId: string; ticketId: string }) => void;
  onOpenTicket: (ticketId: string) => void;
  /**
   * 最大化中か (bdboard-0hcx)。state は App 側が持つ。
   *
   * このコンポーネントで useState すると、App の ErrorBoundary が
   * key={selectedTicketId} を持つ (App.tsx) ためチケットを1つたどるたびに
   * unmount/remount され、最大化が毎回解除される。ChatPanel 側の
   * ErrorBoundary には key が無いので同じ書き方で問題にならないが、詳細パネルは
   * 「盤面のカードを次々開く」使い方をするので寿命がまったく違う
   * (PR#242 opus レビュー major-1)。
   */
  isMaximized: boolean;
  onToggleMaximized: () => void;
  /**
   * 詳細パネル内で1つ前のチケットへ戻る (bdboard-4ql7)。
   * 戻り先が無いときは undefined — ボタン自体を出さない。
   */
  onBackTicket?: (() => void) | undefined;
  isTicketOnBoard: (ticketId: string) => boolean;
  onFilterByEpic: (ticketId: string) => void;
  onTicketViewed?: (entry: { id: string; title: string; projectId: string }) => void;
  availableLabels?: readonly string[];
}

/**
 * 「次に実行」のコピーは現在の run と履歴の run で別々に出るので、コピー完了
 * バッジもその 2 箇所を区別する (bdboard-pkr6.11)。
 */
type NextStepCopyTarget = 'next-step-current' | 'next-step-history';

type CopyFeedback =
  | { kind: 'success'; command: BdCommandKind | NextStepCopyTarget }
  | { kind: 'error' };

/**
 * コピー結果の表示。ボタン脇のバッジ (feedback) と読み上げ (aria) は必ず一緒に
 * 出て一緒に消えるので、1つの値として useAutoClearedValue に持たせる
 * (bdboard-ty72)。別々の state にすると自動消去タイマーも2本になる。
 */
interface CopyDisplay {
  readonly feedback: CopyFeedback | null;
  readonly aria: string;
}

const EMPTY_COPY_DISPLAY: CopyDisplay = { feedback: null, aria: '' };

type ConfirmingQuickAction =
  | { kind: 'claim' }
  | { kind: 'close' }
  | { kind: 'defer'; untilDate: string }
  | { kind: 'priority'; priority: number };

type SubmittedDecision = {
  decisionId: string;
  choiceLabel?: string;
  freeform?: string;
  outcome: TicketDecisionOutcome;
};

function formatQuickActionConfirmTitle(action: ConfirmingQuickAction): string {
  switch (action.kind) {
    case 'claim':
      return '着手の確認';
    case 'close':
      return '完了の確認';
    case 'defer':
      return '延期の確認';
    case 'priority':
      return '優先度変更の確認';
  }
}

function formatQuickActionConfirmDescription(
  action: ConfirmingQuickAction,
): string {
  switch (action.kind) {
    case 'claim':
      return 'このチケットを着手(claim)します。よろしいですか?';
    case 'close':
      return 'このチケットをクローズします。よろしいですか?';
    case 'defer':
      return `${action.untilDate} まで延期します。よろしいですか?`;
    case 'priority':
      return `優先度を P${action.priority} に変更します。よろしいですか?`;
  }
}

function toQuickActionRequest(action: ConfirmingQuickAction, closeReason: string): QuickActionRequest {
  switch (action.kind) {
    case 'claim':
      return { action: 'claim' };
    case 'close': {
      const trimmedReason = closeReason.trim();
      return {
        action: 'close',
        ...(trimmedReason.length > 0 ? { reason: trimmedReason } : {}),
      };
    }
    case 'defer':
      return { action: 'defer', untilDate: action.untilDate };
    case 'priority':
      return { action: 'priority', priority: action.priority };
  }
}

function formatDateTime(value: string | undefined): string {
  if (value === undefined) return '—';
  return formatAbsoluteTime(value);
}

function formatTokenCount(value: number): string {
  return value.toLocaleString();
}

function sessionLinkBadgeLabel(source: 'metadata' | 'transcript'): string {
  return source === 'metadata' ? '手動' : '自動推定';
}

function sessionLinkBadgeClass(source: 'metadata' | 'transcript'): string {
  return source === 'metadata' ? 'badge-link-manual' : 'badge-link-inferred';
}

function formatSessionPickerLabel(session: SessionDto): string {
  return session.name !== undefined
    ? `${session.name} (${session.cwd})`
    : `${session.sessionId} (${session.cwd})`;
}

export const AGENT_RUN_LOG_LOCAL_ONLY_HELP =
  'ログはこのPCのローカル画面からのみ表示できます。';

function computeRunStartDisabled(
  ticket: TicketDetailDto,
  hasActiveRun: boolean,
  nowMs: number = Date.now(),
): { disabled: boolean; reason?: string } {
  if (ticket.status === 'closed') {
    return { disabled: true, reason: '完了済みのチケットは実行できません' };
  }
  if (
    (ticket.status === 'open' || ticket.status === 'pinned') &&
    ticket.blockedBy.length > 0
  ) {
    return { disabled: true, reason: 'ブロック中のチケットは実行できません' };
  }
  if (
    ticket.deferUntil !== undefined &&
    new Date(ticket.deferUntil).getTime() > nowMs
  ) {
    return { disabled: true, reason: '保留中のチケットは実行できません' };
  }
  if (hasActiveRun) {
    return { disabled: true };
  }
  return { disabled: false };
}

export const AGENT_RUN_NEXT_STEP_LABEL = '次に実行';

/**
 * run 完了後に人が run の外で回す検証コマンド (bdboard-pkr6.11 仕様4)。
 * run 内では検証できないので、終わったあとの導線をここに置く。
 */
function AgentRunNextStep({
  nextStep,
  target,
  copied,
  onCopy,
}: {
  nextStep: AgentRunNextStepDto;
  target: NextStepCopyTarget;
  copied: boolean;
  onCopy: (target: NextStepCopyTarget, nextStep: AgentRunNextStepDto) => void;
}) {
  const command = buildRunNextStepCommand(nextStep);

  return (
    <div className="agent-run-next-step">
      <span className="agent-run-next-step-label">{AGENT_RUN_NEXT_STEP_LABEL}:</span>
      <code className="agent-run-next-step-command">{command}</code>
      <button
        type="button"
        className="btn btn-small agent-run-next-step-copy"
        aria-label={`次に実行するコマンドをコピー: ${command}`}
        onClick={() => onCopy(target, nextStep)}
      >
        {copied ? 'コピーしました' : 'コピー'}
      </button>
    </div>
  );
}

function formatAgentRunStatus(status: AgentRunSummaryDto['status']): string {
  switch (status) {
    case 'pending':
      return '待機中';
    case 'running':
      return '実行中';
    case 'cancelling':
      return '中止中…';
    case 'succeeded':
      return '成功';
    case 'failed':
      return '失敗';
    case 'cancelled':
      return '中止';
  }
}

interface TicketIdLinkProps {
  id: string;
  isTicketOnBoard: (ticketId: string) => boolean;
  onOpenTicket: (ticketId: string) => void;
}

function TicketIdLink({ id, isTicketOnBoard, onOpenTicket }: TicketIdLinkProps) {
  if (isTicketOnBoard(id)) {
    return (
      <button
        type="button"
        className="ticket-id-link"
        onClick={() => onOpenTicket(id)}
      >
        {id}
      </button>
    );
  }

  return (
    <span className="ticket-id-unavailable" title="現在のボードに表示されていません">
      {id}
    </span>
  );
}

export function TicketDetailPanel({
  ticketId,
  projectRootPaths,
  pendingDecision,
  prLink,
  onClose,
  onChatAboutTicket,
  onOpenTicket,
  onBackTicket,
  isTicketOnBoard,
  onFilterByEpic,
  onTicketViewed,
  isMaximized,
  onToggleMaximized,
  availableLabels = [],
}: TicketDetailPanelProps) {
  const detailPanel = useResizableSidePanel(
    UI_STORAGE_KEYS.ticketDetailPanelWidth,
  );
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

  const [submittedDecision, setSubmittedDecision] =
    useState<SubmittedDecision | null>(null);
  const commentsEnabled =
    data !== undefined &&
    (data.commentCount > 0 || submittedDecision !== null);
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
  // エージェント実行の前提 (bdboard-pkr6.11)。ProjectHarnessBadges と同じ
  // queryKey なので、同じプロジェクトを表示中なら取得は 1 回に畳まれる。
  const harnessProjectId = data?.projectId;
  const { data: harnessStatus } = useQuery({
    queryKey: ['project-harness', harnessProjectId],
    queryFn: () => {
      if (harnessProjectId === undefined) {
        throw new Error('project id is required');
      }
      return fetchProjectHarnessStatus(harnessProjectId);
    },
    enabled: harnessProjectId !== undefined,
    // 前提の可視化が目的なので、落ちたら黙って未取得のまま (= ブロックしない)。
    // リトライで詳細パネルを開くたびに 3 回叩く価値は無い。
    retry: false,
  });
  const harnessRunBlockReason = describeHarnessRunBlock(harnessStatus);
  const {
    data: ticketRunsData,
    isLoading: ticketRunsLoading,
    error: ticketRunsError,
  } = useQuery({
    queryKey: ['ticket-runs', ticketId],
    queryFn: () => fetchTicketRuns(ticketId),
  });
  const [confirmingAgentRun, setConfirmingAgentRun] = useState(false);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [activeRunMeta, setActiveRunMeta] = useState<{
    worktreePath: string;
    branchName: string;
    reused: boolean;
  } | null>(null);
  const [polledRunDetail, setPolledRunDetail] = useState<AgentRunDetailDto | null>(
    null,
  );
  const [runStatusUnavailable, setRunStatusUnavailable] = useState(false);
  const [selectedHistoryRunId, setSelectedHistoryRunId] = useState<string | null>(
    null,
  );
  // bdboard-ty72: コピー表示は copyTextToClipboard の継続から出るので、素の
  // setTimeout だとアンマウント後にタイマーを仕掛けうる。
  const {
    value: copyDisplay,
    show: showCopyDisplay,
    clear: clearCopyDisplay,
  } = useAutoClearedValue<CopyDisplay>(EMPTY_COPY_DISPLAY, COPY_FEEDBACK_MS);
  const copyFeedback = copyDisplay.feedback;
  const ariaLiveMessage = copyDisplay.aria;
  const [selectedChoice, setSelectedChoice] = useState<string | undefined>(
    undefined,
  );
  const [freeformText, setFreeformText] = useState('');
  const [confirmingQuickAction, setConfirmingQuickAction] =
    useState<ConfirmingQuickAction | null>(null);
  const [deferPeriodKind, setDeferPeriodKind] =
    useState<DeferPeriodKind>(DEFAULT_DEFER_PERIOD);
  const [customDeferDate, setCustomDeferDate] = useState('');
  const [closeReason, setCloseReason] = useState('');
  const [commentText, setCommentText] = useState('');
  const [dependencySearchQuery, setDependencySearchQuery] = useState('');
  const [dependencyCandidates, setDependencyCandidates] = useState<
    TicketSearchResultDto[]
  >([]);
  const [dependencySearchLoading, setDependencySearchLoading] = useState(false);
  const [dependencySearchError, setDependencySearchError] = useState<Error | null>(
    null,
  );
  const [labelInputQuery, setLabelInputQuery] = useState('');
  const [titleEditing, setTitleEditing] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const [expectedCurrentTitle, setExpectedCurrentTitle] = useState('');
  const [descriptionEditing, setDescriptionEditing] = useState(false);
  const [descriptionDraft, setDescriptionDraft] = useState('');
  const [expectedCurrentDescription, setExpectedCurrentDescription] =
    useState('');
  const [sessionLinkPickerOpen, setSessionLinkPickerOpen] = useState(false);
  const prevCommentCountRef = useRef<number | undefined>(undefined);
  const panelRef = useRef<HTMLDivElement>(null);
  const commentTextareaRef = useRef<HTMLTextAreaElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const cancelQuickActionRef = useRef<HTMLButtonElement>(null);
  const quickActionConfirmRef = useRef<HTMLDivElement>(null);
  const cancelAgentRunConfirmRef = useRef<HTMLButtonElement>(null);
  const agentRunConfirmRef = useRef<HTMLDivElement>(null);
  const projectRootPath =
    data === undefined ? undefined : projectRootPaths.get(data.projectId);

  // 質問への回答欄だけを初期化する。resetFormState はこれを含む全体リセット。
  const resetDecisionAnswer = useCallback(() => {
    setSelectedChoice(undefined);
    setFreeformText('');
  }, []);

  const resetFormState = useCallback((options?: { clearSubmittedDecision?: boolean }) => {
    clearCopyDisplay();
    resetDecisionAnswer();
    if (options?.clearSubmittedDecision === true) {
      setSubmittedDecision(null);
    }
    setConfirmingQuickAction(null);
    setDeferPeriodKind(DEFAULT_DEFER_PERIOD);
    setCustomDeferDate('');
    setCloseReason('');
    setCommentText('');
    setDependencySearchQuery('');
    setDependencyCandidates([]);
    setDependencySearchLoading(false);
    setDependencySearchError(null);
    setLabelInputQuery('');
    setTitleEditing(false);
    setTitleDraft('');
    setExpectedCurrentTitle('');
    setDescriptionEditing(false);
    setDescriptionDraft('');
    setExpectedCurrentDescription('');
    setSessionLinkPickerOpen(false);
    setConfirmingAgentRun(false);
    setActiveRunId(null);
    setActiveRunMeta(null);
    setPolledRunDetail(null);
    setSelectedHistoryRunId(null);
  }, [clearCopyDisplay, resetDecisionAnswer]);

  useEffect(() => {
    resetFormState({ clearSubmittedDecision: true });
  }, [ticketId, projectRootPath, resetFormState]);

  useFocusTrap({
    containerRef: panelRef,
    initialFocusRef: closeButtonRef,
    onEscape: onClose,
    enabled: confirmingQuickAction === null && !confirmingAgentRun,
  });

  const handleCancelQuickAction = useCallback(() => {
    setConfirmingQuickAction(null);
    setDeferPeriodKind(DEFAULT_DEFER_PERIOD);
    setCustomDeferDate('');
    setCloseReason('');
  }, []);

  useFocusTrap({
    containerRef: quickActionConfirmRef,
    initialFocusRef: cancelQuickActionRef,
    enabled: confirmingQuickAction !== null,
    onEscape: handleCancelQuickAction,
  });

  const handleCancelAgentRun = useCallback(() => {
    setConfirmingAgentRun(false);
  }, []);

  useFocusTrap({
    containerRef: agentRunConfirmRef,
    initialFocusRef: cancelAgentRunConfirmRef,
    enabled: confirmingAgentRun,
    onEscape: handleCancelAgentRun,
  });

  const activeRunFromList = useMemo(() => {
    return ticketRunsData?.runs.find((run) => isAgentRunInProgress(run.status));
  }, [ticketRunsData]);

  const hasActiveRun = useMemo(() => {
    if (runStatusUnavailable) {
      return false;
    }
    if (
      polledRunDetail !== null &&
      isAgentRunInProgress(polledRunDetail.status)
    ) {
      return true;
    }
    if (activeRunFromList !== undefined) {
      return true;
    }
    if (activeRunId !== null && polledRunDetail === null) {
      return true;
    }
    return false;
  }, [activeRunFromList, activeRunId, polledRunDetail, runStatusUnavailable]);

  const runStartDisabled = useMemo(() => {
    if (data === undefined) {
      return { disabled: true };
    }
    return computeRunStartDisabled(data, hasActiveRun);
  }, [data, hasActiveRun]);

  useEffect(() => {
    if (activeRunFromList === undefined) {
      return;
    }
    setActiveRunId(activeRunFromList.id);
  }, [activeRunFromList?.id, ticketId]);

  const {
    data: selectedHistoryRun,
    isLoading: selectedHistoryRunLoading,
    error: selectedHistoryRunError,
  } = useQuery({
    queryKey: ['agent-run', selectedHistoryRunId],
    queryFn: () => fetchAgentRun(selectedHistoryRunId!),
    enabled: selectedHistoryRunId !== null,
  });

  useEffect(() => {
    if (activeRunId === null) {
      setPolledRunDetail(null);
      setRunStatusUnavailable(false);
      return;
    }

    let cancelled = false;
    let intervalId: ReturnType<typeof setInterval> | undefined;
    let consecutiveFailures = 0;

    setRunStatusUnavailable(false);
    consecutiveFailures = 0;

    const poll = async (): Promise<AgentRunDetailDto | null> => {
      try {
        const detail = await fetchAgentRun(activeRunId);
        if (cancelled) {
          return null;
        }
        consecutiveFailures = 0;
        setRunStatusUnavailable(false);
        setPolledRunDetail(detail);
        if (!isAgentRunInProgress(detail.status)) {
          void queryClient.invalidateQueries({
            queryKey: ['ticket-runs', ticketId],
          });
        }
        return detail;
      } catch (pollError) {
        console.error('Failed to poll agent run', pollError);
        if (cancelled) {
          return null;
        }
        consecutiveFailures += 1;
        if (consecutiveFailures >= AGENT_RUN_POLL_MAX_FAILURES) {
          setRunStatusUnavailable(true);
          if (intervalId !== undefined) {
            clearInterval(intervalId);
            intervalId = undefined;
          }
        }
        return null;
      }
    };

    void (async () => {
      const initialDetail = await poll();
      if (cancelled || consecutiveFailures >= AGENT_RUN_POLL_MAX_FAILURES) {
        return;
      }
      if (
        initialDetail !== null &&
        !isAgentRunInProgress(initialDetail.status)
      ) {
        return;
      }

      intervalId = setInterval(() => {
        void (async () => {
          const detail = await poll();
          if (cancelled || consecutiveFailures >= AGENT_RUN_POLL_MAX_FAILURES) {
            return;
          }
          if (
            detail !== null &&
            !isAgentRunInProgress(detail.status) &&
            intervalId !== undefined
          ) {
            clearInterval(intervalId);
            intervalId = undefined;
          }
        })();
      }, AGENT_RUN_POLL_INTERVAL_MS);
    })();

    return () => {
      cancelled = true;
      if (intervalId !== undefined) {
        clearInterval(intervalId);
      }
    };
  }, [activeRunId, queryClient, ticketId]);

  const startRunMutation = useMutation({
    mutationFn: () => startTicketRun(ticketId),
    onSuccess: (response) => {
      setConfirmingAgentRun(false);
      setActiveRunId(response.runId);
      setActiveRunMeta({
        worktreePath: response.worktreePath,
        branchName: response.branchName,
        reused: response.reused,
      });
      void queryClient.invalidateQueries({ queryKey: ['ticket-runs', ticketId] });
    },
  });

  const cancelRunMutation = useMutation({
    mutationFn: async () => {
      if (activeRunId === null) {
        throw new Error('active run is not available');
      }
      await cancelAgentRun(activeRunId);
    },
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

  const handleCopyCommand = useCallback(
    async (kind: BdCommandKind) => {
      const command = buildBdCommand(kind, ticketId, projectRootPath);
      const definition = BD_COMMAND_DEFINITIONS.find((entry) => entry.kind === kind);

      try {
        await copyTextToClipboard(command);
        showCopyDisplay({
          feedback: { kind: 'success', command: kind },
          aria: `${definition?.label ?? 'コマンド'}をコピーしました`,
        });
      } catch (copyError) {
        console.error('Failed to copy bd command', copyError);
        showCopyDisplay({
          feedback: { kind: 'error' },
          aria: 'コピーできませんでした',
        });
      }
    },
    [projectRootPath, showCopyDisplay, ticketId],
  );

  const handleCopyNextStep = useCallback(
    async (target: NextStepCopyTarget, nextStep: AgentRunNextStepDto) => {
      const command = buildRunNextStepCommand(nextStep);
      try {
        await copyTextToClipboard(command);
        showCopyDisplay({
          feedback: { kind: 'success', command: target },
          aria: '次に実行するコマンドをコピーしました',
        });
      } catch (copyError) {
        console.error('Failed to copy next step command', copyError);
        showCopyDisplay({
          feedback: { kind: 'error' },
          aria: 'コピーできませんでした',
        });
      }
    },
    [showCopyDisplay],
  );

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
  // 全体リセットは上の effect が担当する。
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

  const quickActionMutation = useMutation({
    mutationFn: async (vars: {
      request: QuickActionRequest;
      previousPriority?: number;
    }) => {
      await postTicketQuickAction(ticketId, vars.request);
      return vars;
    },
    onSuccess: async (vars) => {
      await queryClient.invalidateQueries({ queryKey: ['ticket', ticketId] });
      await queryClient.invalidateQueries({ queryKey: ['board'] });
      setConfirmingQuickAction(null);
      setCloseReason('');

      // 誤操作からの復帰用にUndoスナックバーを出す(bdboard-3tw.69: 確認ダイアログの
      // 代わりの事後Undo)。priority は実行前の値(vars.previousPriority)を
      // handleConfirmQuickAction 側で確定当時の data.priority から渡している。
      const plan = planQuickActionUndo(vars.request, vars.previousPriority);
      if (plan !== null) {
        undoSnackbar?.showUndo({
          message: plan.message,
          onUndo: async () => {
            await postTicketQuickActionUndo(ticketId, plan.undoRequest);
            await queryClient.invalidateQueries({
              queryKey: ['ticket', ticketId],
            });
            await queryClient.invalidateQueries({ queryKey: ['board'] });
          },
        });
      }
    },
  });

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

  const trimmedDependencySearchQuery = dependencySearchQuery.trim();
  const hasDependencySearchQuery = trimmedDependencySearchQuery.length > 0;

  useEffect(() => {
    if (data === undefined || !hasDependencySearchQuery) {
      setDependencyCandidates([]);
      setDependencySearchLoading(false);
      setDependencySearchError(null);
      return;
    }

    let cancelled = false;
    setDependencySearchLoading(true);
    setDependencySearchError(null);

    const handle = window.setTimeout(() => {
      void searchTickets(trimmedDependencySearchQuery, DEPENDENCY_SEARCH_LIMIT)
        .then((hits) => {
          if (cancelled) return;
          setDependencyCandidates(
            filterDependencyCandidates(hits, {
              ticketId: data.id,
              projectId: data.projectId,
              existingDependsOnIds: data.dependencies.map(
                (dep) => dep.dependsOnId,
              ),
            }),
          );
          setDependencySearchLoading(false);
        })
        .catch((caught: unknown) => {
          if (cancelled) return;
          setDependencySearchError(
            caught instanceof Error ? caught : new Error('検索に失敗しました'),
          );
          setDependencyCandidates([]);
          setDependencySearchLoading(false);
        });
    }, DEPENDENCY_SEARCH_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [
    data,
    hasDependencySearchQuery,
    trimmedDependencySearchQuery,
  ]);

  const addDependencyMutation = useMutation({
    mutationFn: async (dependsOnId: string) => {
      await postTicketDependency(ticketId, dependsOnId);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['ticket', ticketId] });
      setDependencySearchQuery('');
      setDependencyCandidates([]);
    },
  });

  const removeDependencyMutation = useMutation({
    mutationFn: async (dependsOnId: string) => {
      await deleteTicketDependency(ticketId, dependsOnId);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['ticket', ticketId] });
    },
  });

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

  const dependencyMutationPending =
    addDependencyMutation.isPending || removeDependencyMutation.isPending;
  const dependencyMutationError =
    addDependencyMutation.error ?? removeDependencyMutation.error;

  const labelMutationPending =
    addLabelMutation.isPending || removeLabelMutation.isPending;
  const labelMutationError = addLabelMutation.error ?? removeLabelMutation.error;

  const updateTitleMutation = useMutation({
    mutationFn: async () => {
      await patchTicketTitle(
        ticketId,
        titleDraft.trim(),
        expectedCurrentTitle,
      );
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['ticket', ticketId] });
      await queryClient.invalidateQueries({ queryKey: ['board'] });
      setTitleEditing(false);
      setTitleDraft('');
      setExpectedCurrentTitle('');
    },
    onError: async (error) => {
      if (error instanceof ApiError && error.status === 409) {
        await queryClient.invalidateQueries({ queryKey: ['ticket', ticketId] });
        setTitleEditing(false);
        setTitleDraft('');
        setExpectedCurrentTitle('');
      }
    },
  });

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

  const trimmedTitleDraft = titleDraft.trim();
  const canSaveTitle =
    trimmedTitleDraft.length > 0 && trimmedTitleDraft !== expectedCurrentTitle;

  const currentLabels = data?.labels ?? [];
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

  const handleStartTitleEdit = useCallback(() => {
    if (data === undefined) {
      return;
    }
    setTitleDraft(data.title);
    setExpectedCurrentTitle(data.title);
    setTitleEditing(true);
  }, [data]);

  const handleCancelTitleEdit = useCallback(() => {
    setTitleEditing(false);
    setTitleDraft('');
    setExpectedCurrentTitle('');
  }, []);

  const handleSaveTitle = useCallback(() => {
    if (!canSaveTitle || updateTitleMutation.isPending) {
      return;
    }
    updateTitleMutation.mutate();
  }, [canSaveTitle, updateTitleMutation]);

  const handleStartDescriptionEdit = useCallback(() => {
    if (data === undefined) {
      return;
    }
    const current = data.description ?? '';
    setDescriptionDraft(current);
    setExpectedCurrentDescription(current);
    setDescriptionEditing(true);
  }, [data]);

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

  const handleConfirmQuickAction = useCallback(() => {
    if (confirmingQuickAction === null) {
      return;
    }

    quickActionMutation.mutate({
      request: toQuickActionRequest(confirmingQuickAction, closeReason),
      // priority のUndoは「実行前の値へ戻す」ため、確定操作の時点(=まだ古い値を
      // 表示している data)から previousPriority を採取する。invalidate 後に
      // data.priority を読むと新しい値になってしまうため、ここで確定させる。
      ...(confirmingQuickAction.kind === 'priority' && data !== undefined
        ? { previousPriority: data.priority }
        : {}),
    });
  }, [closeReason, confirmingQuickAction, data, quickActionMutation]);

  const canRaisePriority = data !== undefined && data.priority > 0;
  const canLowerPriority = data !== undefined && data.priority < 4;
  const quickActionsDisabled =
    quickActionMutation.isPending ||
    confirmingQuickAction !== null ||
    confirmingAgentRun ||
    startRunMutation.isPending;
  const agentRunActionsDisabled =
    startRunMutation.isPending ||
    confirmingQuickAction !== null ||
    confirmingAgentRun;
  const deferSubmitDisabled =
    deferPeriodKind === 'custom' && !isFutureLocalDate(customDeferDate);

  const handleDeferQuickAction = useCallback(() => {
    const untilDate =
      deferPeriodKind === 'custom'
        ? customDeferDate
        : computeDeferUntilDate(deferPeriodKind);
    setConfirmingQuickAction({ kind: 'defer', untilDate });
  }, [customDeferDate, deferPeriodKind]);

  return (
    <div
      className="overlay"
      onClick={onClose}
      role="presentation"
    >
      <div
        ref={panelRef}
        className={`detail-panel resizable-side-panel${detailPanel.isResizing ? ' is-resizing' : ''}${isMaximized ? ' is-maximized' : ''}`}
        style={{ width: isMaximized ? '100%' : `${detailPanel.width}px` }}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.defaultPrevented) {
            return;
          }
          if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) {
            return;
          }
          if (event.key !== 'c') {
            return;
          }
          const target = event.target;
          if (target instanceof HTMLElement) {
            const tag = target.tagName;
            if (
              tag === 'INPUT' ||
              tag === 'TEXTAREA' ||
              tag === 'SELECT' ||
              target.isContentEditable
            ) {
              return;
            }
          }
          if (confirmingQuickAction !== null || confirmingAgentRun) {
            return;
          }
          const textarea = commentTextareaRef.current;
          if (textarea === null || textarea.disabled) {
            return;
          }
          event.preventDefault();
          textarea.focus();
          if (typeof textarea.scrollIntoView === 'function') {
            textarea.scrollIntoView({ block: 'nearest' });
          }
        }}
        role="dialog"
        aria-modal="true"
        aria-labelledby="detail-title"
        tabIndex={-1}
      >
        {/* 最大化中は幅が 100% 固定なのでハンドルは出さない (ChatPanel と同じ) */}
        {!isMaximized && (
          <SidePanelResizeHandle
            label="チケット詳細パネルの幅を変更"
            panel={detailPanel}
          />
        )}
        {/* .detail-header は7パネル共有のため、モバイル向け縦積みは ticket-detail-header
            修飾クラスで詳細パネルだけに限定する (bdboard-h4xs.2)。 */}
        <div className="detail-header ticket-detail-header">
          {titleEditing ? (
            <>
              <h2 id="detail-title" className="sr-only">
                {data?.title ?? 'チケット詳細'}
              </h2>
              <div className="detail-title-edit">
                <label
                  className="detail-field-label"
                  htmlFor="detail-title-input"
                >
                  タイトル
                </label>
                <input
                  id="detail-title-input"
                  type="text"
                  className="detail-title-input"
                  value={titleDraft}
                  onChange={(event) => setTitleDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      handleSaveTitle();
                    }
                  }}
                  disabled={updateTitleMutation.isPending}
                  maxLength={200}
                />
              <div className="detail-inline-edit-actions">
                <button
                  type="button"
                  className="btn btn-small"
                  disabled={!canSaveTitle || updateTitleMutation.isPending}
                  onClick={handleSaveTitle}
                >
                  {updateTitleMutation.isPending ? '保存中…' : '保存'}
                </button>
                <button
                  type="button"
                  className="btn btn-small"
                  disabled={updateTitleMutation.isPending}
                  onClick={handleCancelTitleEdit}
                >
                  キャンセル
                </button>
              </div>
              {updateTitleMutation.error !== null && (
                <p className="error-message">
                  {describeWriteError(
                    updateTitleMutation.error,
                    'タイトルの更新に失敗しました',
                  )}
                </p>
              )}
              </div>
            </>
          ) : (
            <div className="detail-title-row">
              <h2 id="detail-title" className="detail-title">
                {isLoading ? '読み込み中…' : data?.title ?? 'チケット詳細'}
              </h2>
              {data !== undefined && (
                <button
                  type="button"
                  className="btn btn-small detail-inline-edit-btn"
                  aria-label="タイトルを編集"
                  onClick={handleStartTitleEdit}
                >
                  編集
                </button>
              )}
            </div>
          )}
          <div className="detail-header-actions">
            {onBackTicket !== undefined && (
              <button
                type="button"
                className="btn btn-small detail-back"
                /* 「←」をアクセシブルネームに含めると読み上げが「左向き矢印、
                   戻る」になるので、同ヘッダーの「タイトルを編集」と同じく
                   aria-label でラベルを与える (PR#241 レビュー minor-4)。 */
                aria-label="前のチケットへ戻る"
                onClick={onBackTicket}
              >
                ← 戻る
              </button>
            )}
            <WatchToggle ticketId={ticketId} className="detail-watch-toggle" />
            <button
              type="button"
              className="btn btn-small detail-maximize"
              onClick={(event) => {
                /*
                 * 最大化するとリサイズハンドルが DOM から外れる。ハンドルに
                 * フォーカスがあるままだと activeElement が body に落ち、
                 * useFocusTrap がパネル要素に張った keydown を受け取れなくなって
                 * Escape で閉じられなくなる (PR#242 opus レビュー minor-1)。
                 * Chrome/Firefox は button クリックでフォーカスがボタンへ移るので
                 * 踏まないが、Safari/macOS は button にフォーカスを与えない。
                 */
                if (!isMaximized) {
                  event.currentTarget.focus();
                }
                onToggleMaximized();
              }}
              title={isMaximized ? '元の幅に戻す' : '画面幅いっぱいに広げる'}
            >
              {/* aria-pressed は付けない。ラベル自体が「最大化」/「縮小」と
                  入れ替わるので、押下状態も併せて伝えると「縮小、押されています」
                  = 縮小が有効、と逆に読める (ChatPanel と同じ判断)。 */}
              {isMaximized ? '縮小' : '最大化'}
            </button>
            <button
              ref={closeButtonRef}
              type="button"
              className="btn detail-close"
              onClick={onClose}
            >
              閉じる
            </button>
          </div>
        </div>

        {isLoading && <p className="loading">読み込み中…</p>}
        {error !== null && (
          <p className="error-message">
            {error instanceof Error ? error.message : '読み込みに失敗しました'}
          </p>
        )}
        {data !== undefined && (
          <>
            <div className="ticket-action-buttons">
              {onChatAboutTicket !== undefined && (
                <button
                  type="button"
                  className="btn ticket-chat-btn"
                  onClick={() =>
                    onChatAboutTicket({
                      projectId: data.projectId,
                      ticketId: data.id,
                    })
                  }
                >
                  このチケットについてチャット
                </button>
              )}
              <button
                type="button"
                className="btn ticket-run-btn"
                disabled={
                  agentRunActionsDisabled ||
                  runStartDisabled.disabled ||
                  harnessRunBlockReason !== null
                }
                title={runStartDisabled.reason ?? harnessRunBlockReason ?? undefined}
                onClick={() => setConfirmingAgentRun(true)}
              >
                ▶ 実行
              </button>
              {harnessRunBlockReason !== null && (
                <span className="agent-run-blocked-reason">
                  {harnessRunBlockReason}
                </span>
              )}
              {hasActiveRun && (
                <span className="agent-run-active-indicator">実行中</span>
              )}
            </div>
            {confirmingAgentRun && (
              <div
                ref={agentRunConfirmRef}
                className="quick-action-confirm-panel agent-run-confirm-panel"
                role="alertdialog"
                aria-labelledby="agent-run-confirm-title"
                aria-describedby="agent-run-confirm-desc"
              >
                <p
                  id="agent-run-confirm-title"
                  className="quick-action-confirm-title"
                >
                  エージェント実行の確認
                </p>
                <p
                  id="agent-run-confirm-desc"
                  className="quick-action-confirm-desc"
                >
                  対象チケット用の worktree（.claude/worktrees/{ticketId}
                  ）を新規作成するか、既に存在してクリーンならそれを再利用して、Claude
                  CLI を起動します。対象 worktree
                  に未コミットの変更がある場合は実行できません。よろしいですか?
                </p>
                <div className="quick-action-confirm-actions">
                  <button
                    ref={cancelAgentRunConfirmRef}
                    type="button"
                    className="btn quick-action-confirm-cancel"
                    onClick={handleCancelAgentRun}
                    disabled={startRunMutation.isPending}
                  >
                    キャンセル
                  </button>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => startRunMutation.mutate()}
                    disabled={startRunMutation.isPending}
                  >
                    {startRunMutation.isPending ? '実行中…' : '実行する'}
                  </button>
                </div>
              </div>
            )}
            {startRunMutation.error !== null && (
              <p className="error-message">
                {describeRunStartError(startRunMutation.error)}
              </p>
            )}
            <div className="detail-field">
              <div className="detail-field-label">ID</div>
              <div>{data.id}</div>
            </div>
            <div className="detail-field">
              <div className="detail-field-label">Status</div>
              <div>{data.status}</div>
            </div>
            <div className="detail-field">
              <div className="detail-field-label">Priority</div>
              <div>P{data.priority}</div>
            </div>
            <div className="detail-field">
              <div className="detail-field-label">Issue Type</div>
              <div>{data.issueType}</div>
            </div>
            {prLink !== undefined && (
              <div className="detail-field">
                <div className="detail-field-label">PR</div>
                <div>
                  <PrLinkBadge prLink={prLink} />
                </div>
              </div>
            )}
            {data.assignee !== undefined && (
              <div className="detail-field">
                <div className="detail-field-label">Assignee</div>
                <div>{data.assignee}</div>
              </div>
            )}
            {data.owner !== undefined && (
              <div className="detail-field">
                <div className="detail-field-label">Owner</div>
                <div>{data.owner}</div>
              </div>
            )}
            <div className="detail-field">
              <div className="detail-field-label">Labels</div>
              {currentLabels.length > 0 && (
                <div className="detail-label-badges">
                  {currentLabels.map((label) => (
                    <span key={label} className="badge badge-label">
                      {label}
                      <button
                        type="button"
                        className="btn btn-small label-remove-btn"
                        aria-label={`ラベル ${label} を削除`}
                        disabled={labelMutationPending}
                        onClick={() => removeLabelMutation.mutate(label)}
                      >
                        削除
                      </button>
                    </span>
                  ))}
                </div>
              )}
              <label className="label-add-label" htmlFor="label-add-input">
                ラベルを追加
              </label>
              <input
                id="label-add-input"
                type="text"
                className="label-add-input"
                value={labelInputQuery}
                onChange={(event) => setLabelInputQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    if (canSubmitLabel && !labelMutationPending) {
                      handleAddLabel(trimmedLabelInput);
                    }
                  }
                }}
                disabled={labelMutationPending}
                maxLength={200}
              />
              {trimmedLabelInput.length > 0 &&
                labelSuggestions.length > 0 && (
                  <ul className="dependency-suggestions label-suggestions">
                    {labelSuggestions.map((label) => (
                      <li key={label}>
                        <button
                          type="button"
                          className="dependency-suggestion-btn"
                          disabled={labelMutationPending}
                          onClick={() => handleAddLabel(label)}
                        >
                          {label}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              <div className="label-add-actions">
                <button
                  type="button"
                  className="btn btn-small"
                  disabled={!canSubmitLabel || labelMutationPending}
                  onClick={() => handleAddLabel(trimmedLabelInput)}
                >
                  {addLabelMutation.isPending ? '追加中…' : '追加'}
                </button>
              </div>
              {labelMutationError !== null && (
                <p className="error-message">
                  {describeWriteError(
                    labelMutationError,
                    'ラベルの更新に失敗しました',
                  )}
                </p>
              )}
            </div>
            {data.parentId !== undefined && (
              <div className="detail-field">
                <div className="detail-field-label">Parent ID</div>
                <div>
                  <TicketIdLink
                    id={data.parentId}
                    isTicketOnBoard={isTicketOnBoard}
                    onOpenTicket={onOpenTicket}
                  />
                </div>
              </div>
            )}
            {data.children.length > 0 && (
              <div className="detail-section">
                <h3>子チケット</h3>
                <ul className="detail-list">
                  {data.children.map((child) => (
                    <li key={child.id}>
                      <TicketIdLink
                        id={child.id}
                        isTicketOnBoard={isTicketOnBoard}
                        onOpenTicket={onOpenTicket}
                      />{' '}
                      <span>{child.title}</span>{' '}
                      <span className="badge">{LANE_LABELS[child.lane]}</span>
                    </li>
                  ))}
                </ul>
                <button
                  type="button"
                  className="btn btn-small"
                  onClick={() => onFilterByEpic(data.id)}
                >
                  このエピックのみ表示
                </button>
              </div>
            )}
            {inFlightOverlapsEnabled && inFlightOverlapsError !== null && (
              <div className="detail-section">
                <h3>衝突しうる着手中チケット</h3>
                <p className="detail-help">重複チェックを実行できませんでした。</p>
              </div>
            )}
            {/*
              読み込み中は何も出さない。見出しだけ先に出して直後に消える
              (重複が無ければ節ごと消える) と、開くたびに画面が跳ねる。
            */}
            {inFlightOverlapsEnabled &&
              inFlightOverlapsError === null &&
              inFlightOverlaps !== undefined &&
              inFlightOverlaps.length > 0 && (
                <div className="detail-section">
                  <h3>衝突しうる着手中チケット</h3>
                  <p className="detail-help">
                    同じファイルを編集中の着手中チケットです。どちらかへ寄せるか、
                    マージの順番を先に決めてください。
                  </p>
                  <ul className="detail-list">
                    {inFlightOverlaps.map((overlap: TicketInFlightOverlapDto) => {
                      const shownFiles = overlap.files.slice(
                        0,
                        OVERLAP_FILE_DISPLAY_LIMIT,
                      );
                      const hiddenFileCount = overlap.files.length - shownFiles.length;
                      return (
                        <li key={overlap.ticketId}>
                          <TicketIdLink
                            id={overlap.ticketId}
                            isTicketOnBoard={isTicketOnBoard}
                            onOpenTicket={onOpenTicket}
                          />{' '}
                          <span className="badge">{overlap.files.length} ファイル</span>
                          <ul className="detail-list">
                            {shownFiles.map((file) => (
                              <li key={file}>
                                <code>{file}</code>
                              </li>
                            ))}
                            {hiddenFileCount > 0 && (
                              <li className="detail-help">ほか {hiddenFileCount} 件</li>
                            )}
                          </ul>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}
            <div className="detail-section">
              <h3>似ているチケット</h3>
              {similarTicketsLoading && (
                <p className="detail-help">読み込み中…</p>
              )}
              {similarTicketsError !== null && (
                <p className="detail-help">似ているチケットの取得に失敗しました。</p>
              )}
              {!similarTicketsLoading &&
                similarTicketsError === null &&
                similarTickets !== undefined &&
                similarTickets.length === 0 && (
                  <p className="detail-help">似ているチケットはありません。</p>
                )}
              {similarTickets !== undefined && similarTickets.length > 0 && (
                <ul className="detail-list">
                  {similarTickets.map((similar: TicketSimilarResultDto) => (
                    <li key={similar.id}>
                      <TicketIdLink
                        id={similar.id}
                        isTicketOnBoard={isTicketOnBoard}
                        onOpenTicket={onOpenTicket}
                      />{' '}
                      <span>{similar.title}</span>{' '}
                      <span className="badge">
                        {Math.round(similar.score * 100)}%
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="detail-field">
              <div className="detail-field-label">Created</div>
              <div>{formatDateTime(data.createdAt)}</div>
            </div>
            <div className="detail-field">
              <div className="detail-field-label">Updated</div>
              <div>{formatDateTime(data.updatedAt)}</div>
            </div>
            {data.startedAt !== undefined && (
              <div className="detail-field">
                <div className="detail-field-label">Started</div>
                <div>{formatDateTime(data.startedAt)}</div>
              </div>
            )}
            {data.closedAt !== undefined && (
              <div className="detail-field">
                <div className="detail-field-label">Closed</div>
                <div>{formatDateTime(data.closedAt)}</div>
              </div>
            )}
            {data.deferUntil !== undefined && (
              <div className="detail-field">
                <div className="detail-field-label">Defer Until</div>
                <div>{formatDateTime(data.deferUntil)}</div>
              </div>
            )}
            <div className="detail-section">
              <div className="detail-section-heading-row">
                <h3>Description</h3>
                {!descriptionEditing && (
                  <button
                    type="button"
                    className="btn btn-small detail-inline-edit-btn"
                    aria-label="Description を編集"
                    onClick={handleStartDescriptionEdit}
                  >
                    編集
                  </button>
                )}
              </div>
              {descriptionEditing ? (
                <>
                  <label
                    className="detail-field-label"
                    htmlFor="detail-description-input"
                  >
                    Description
                  </label>
                  <textarea
                    id="detail-description-input"
                    className="detail-description-input"
                    value={descriptionDraft}
                    onChange={(event) =>
                      setDescriptionDraft(event.target.value)
                    }
                    disabled={updateDescriptionMutation.isPending}
                    rows={6}
                    maxLength={4000}
                    aria-label="Description"
                  />
                  <div className="detail-inline-edit-actions">
                    <button
                      type="button"
                      className="btn btn-small"
                      disabled={
                        descriptionDraft === expectedCurrentDescription ||
                        updateDescriptionMutation.isPending
                      }
                      onClick={handleSaveDescription}
                    >
                      {updateDescriptionMutation.isPending
                        ? '保存中…'
                        : '保存'}
                    </button>
                    <button
                      type="button"
                      className="btn btn-small"
                      disabled={updateDescriptionMutation.isPending}
                      onClick={handleCancelDescriptionEdit}
                    >
                      キャンセル
                    </button>
                  </div>
                  {updateDescriptionMutation.error !== null && (
                    <p className="error-message">
                      {describeWriteError(
                        updateDescriptionMutation.error,
                        'Description の更新に失敗しました',
                      )}
                    </p>
                  )}
                </>
              ) : data.description !== undefined ? (
                <MarkdownContent
                  text={data.description}
                  isTicketOnBoard={isTicketOnBoard}
                  onOpenTicket={onOpenTicket}
                  className="markdown-detail"
                />
              ) : (
                <p className="detail-empty">（未設定）</p>
              )}
            </div>
            {data.notes !== undefined && (
              <div className="detail-section">
                <h3>Notes</h3>
                <MarkdownContent
                  text={data.notes}
                  isTicketOnBoard={isTicketOnBoard}
                  onOpenTicket={onOpenTicket}
                  className="markdown-detail"
                />
              </div>
            )}
            <div className="detail-section">
              <h3>Dependencies</h3>
              {data.dependencies.length > 0 && (
                <ul className="detail-list">
                  {data.dependencies.map((dep) => (
                    <li key={`${dep.issueId}-${dep.dependsOnId}-${dep.kind}`}>
                      <TicketIdLink
                        id={dep.issueId}
                        isTicketOnBoard={isTicketOnBoard}
                        onOpenTicket={onOpenTicket}
                      />
                      {' → '}
                      <TicketIdLink
                        id={dep.dependsOnId}
                        isTicketOnBoard={isTicketOnBoard}
                        onOpenTicket={onOpenTicket}
                      />
                      {' '}
                      ({dep.kind})
                      {dep.kind === 'blocks' && (
                        <button
                          type="button"
                          className="btn dependency-remove-btn"
                          aria-label={`${dep.dependsOnId} への依存を削除`}
                          disabled={dependencyMutationPending}
                          onClick={() =>
                            removeDependencyMutation.mutate(dep.dependsOnId)
                          }
                        >
                          削除
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              <label className="dependency-search-label" htmlFor="dependency-search">
                依存を追加(このチケットが待つ相手)
              </label>
              <input
                id="dependency-search"
                type="search"
                className="dependency-search-input"
                value={dependencySearchQuery}
                onChange={(event) => setDependencySearchQuery(event.target.value)}
                disabled={dependencyMutationPending}
              />
              {hasDependencySearchQuery && dependencySearchLoading && (
                <p className="detail-help">検索中…</p>
              )}
              {hasDependencySearchQuery &&
                !dependencySearchLoading &&
                dependencySearchError === null &&
                dependencyCandidates.length === 0 && (
                  <p className="detail-help">該当するチケットがありません</p>
                )}
              {dependencySearchError !== null && (
                <p className="error-message">
                  {dependencySearchError.message}
                </p>
              )}
              {dependencyCandidates.length > 0 && (
                <ul className="dependency-suggestions">
                  {dependencyCandidates.map((candidate) => (
                    <li key={candidate.id}>
                      <button
                        type="button"
                        className="dependency-suggestion-btn"
                        disabled={dependencyMutationPending}
                        onClick={() => addDependencyMutation.mutate(candidate.id)}
                      >
                        <span className="dependency-suggestion-id">
                          {candidate.id}
                        </span>
                        <span className="dependency-suggestion-title">
                          {candidate.title}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {dependencyMutationError !== null && (
                <p className="error-message">
                  {describeDependencyError(dependencyMutationError)}
                </p>
              )}
            </div>
            {data.blockedBy.length > 0 && (
              <div className="detail-section">
                <h3>Blocked By</h3>
                <ul className="detail-list">
                  {data.blockedBy.map((id) => (
                    <li key={id}>
                      <TicketIdLink
                        id={id}
                        isTicketOnBoard={isTicketOnBoard}
                        onOpenTicket={onOpenTicket}
                      />
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {data.blocks.length > 0 && (
              <div className="detail-section">
                <h3>Blocks</h3>
                <ul className="detail-list">
                  {data.blocks.map((id) => (
                    <li key={id}>
                      <TicketIdLink
                        id={id}
                        isTicketOnBoard={isTicketOnBoard}
                        onOpenTicket={onOpenTicket}
                      />
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {data.models !== undefined && data.models.length > 0 && (
              <div className="detail-section">
                <h3>使用モデル</h3>
                <ul className="detail-list">
                  {data.models.map((entry) => (
                    <li key={entry.stage}>
                      <span className="ticket-model-stage">{entry.stage}</span>
                      <span className="ticket-model-name">{entry.model}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <div className="detail-section">
              <h3>セッションリンク</h3>
              {data.sessionLinks.length === 0 && (
                <p className="detail-help">リンクされたセッションはありません</p>
              )}
              {data.sessionLinks.length > 0 && (
                <ul className="session-link-list">
                  {data.sessionLinks.map((link) => (
                    <li key={link.sessionId} className="session-link-item">
                      <span
                        className={`badge ${sessionLinkBadgeClass(link.source)}`}
                      >
                        {sessionLinkBadgeLabel(link.source)}
                      </span>
                      <span className="session-link-id">{link.sessionId}</span>
                      {link.source === 'metadata' && (
                        <button
                          type="button"
                          className="btn session-link-unlink-btn"
                          disabled={sessionLinkMutationPending}
                          aria-label={`${link.sessionId} のリンクを解除`}
                          onClick={() => unlinkSessionMutation.mutate()}
                        >
                          解除
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              <button
                type="button"
                className="btn session-link-picker-toggle-btn"
                disabled={sessionLinkMutationPending}
                onClick={() => setSessionLinkPickerOpen((open) => !open)}
              >
                {sessionLinkPickerOpen ? '閉じる' : 'セッションをリンク'}
              </button>
              {sessionLinkPickerOpen && (
                <>
                  <p className="detail-help">
                    稼働中セッションから選択します(既存の手動リンクは上書きされます)
                  </p>
                  {/* win32 ではセッション検出そのものが動かないため、ここは
                      常に空になる。理由を出さないと「稼働中のセッションが
                      ありません」が壊れているようにしか読めない
                      (bdboard-70z.9, PR#115 fable レビュー minor)。 */}
                  <PlatformLimitationNotice feature="session-discovery" />
                  {activeSessionsQuery.isLoading && (
                    <p className="loading">読み込み中…</p>
                  )}
                  {!activeSessionsQuery.isLoading &&
                    activeSessionCandidates.length === 0 && (
                      <p className="detail-help">稼働中のセッションがありません</p>
                    )}
                  {activeSessionCandidates.length > 0 && (
                    <ul className="dependency-suggestions">
                      {activeSessionCandidates.map((session) => (
                        <li key={session.sessionId}>
                          <button
                            type="button"
                            className="dependency-suggestion-btn"
                            disabled={sessionLinkMutationPending}
                            onClick={() =>
                              linkSessionMutation.mutate(session.sessionId)
                            }
                          >
                            <span className="dependency-suggestion-id">
                              {session.sessionId}
                            </span>
                            <span className="dependency-suggestion-title">
                              {formatSessionPickerLabel(session)}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              )}
              {sessionLinkMutationError !== null && (
                <p className="error-message">
                  {describeWriteError(
                    sessionLinkMutationError,
                    'セッションリンクの更新に失敗しました',
                  )}
                </p>
              )}
            </div>
            {data.usage !== undefined && (
              <div className="detail-section">
                <h3>AI使用量</h3>
                <div className="detail-field">
                  <div className="detail-field-label">入力トークン</div>
                  <div>{formatTokenCount(data.usage.totalInputTokens)}</div>
                </div>
                <div className="detail-field">
                  <div className="detail-field-label">出力トークン</div>
                  <div>{formatTokenCount(data.usage.totalOutputTokens)}</div>
                </div>
                {(data.usage.totalCacheCreationInputTokens > 0 ||
                  data.usage.totalCacheReadInputTokens > 0) && (
                  <>
                    <div className="detail-field">
                      <div className="detail-field-label">キャッシュ作成入力</div>
                      <div>
                        {formatTokenCount(data.usage.totalCacheCreationInputTokens)}
                      </div>
                    </div>
                    <div className="detail-field">
                      <div className="detail-field-label">キャッシュ読み取り入力</div>
                      <div>
                        {formatTokenCount(data.usage.totalCacheReadInputTokens)}
                      </div>
                    </div>
                  </>
                )}
                {data.usage.byModel.length > 0 && (
                  <ul className="detail-list">
                    {data.usage.byModel.map((entry) => (
                      <li key={entry.model}>
                        {entry.model}: 入力 {formatTokenCount(entry.inputTokens)} / 出力{' '}
                        {formatTokenCount(entry.outputTokens)}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            {pendingDecision !== undefined && (
              <div className="detail-section">
                <h3>ユーザー確認待ち</h3>
                {pendingDecision.question !== undefined && (
                  <p className="detail-pre">{pendingDecision.question}</p>
                )}
                {pendingDecision.options !== undefined &&
                  pendingDecision.options.length > 0 && (
                    <div className="decision-options">
                      {pendingDecision.options.map((option) => (
                        <button
                          key={option.value}
                          type="button"
                          className={`toggle-btn decision-option-btn${
                            selectedChoice === option.value ? ' active' : ''
                          }`}
                          onClick={() => setSelectedChoice(option.value)}
                        >
                          {option.label}
                        </button>
                      ))}
                    </div>
                  )}
                <label className="decision-freeform-label" htmlFor="decision-freeform">
                  自由記入
                </label>
                <textarea
                  id="decision-freeform"
                  className="decision-freeform-input"
                  value={freeformText}
                  onChange={(event) => setFreeformText(event.target.value)}
                  rows={4}
                />
                {/*
                 * pendingDecision.kind はキャッシュ由来で 'ticket' に倒れうる。
                 * 'gate' と判定されたときだけ予告を出す片側運用。'ticket' 側には出さない。
                 */}
                {pendingDecision.kind === 'gate' && (
                  <p className="detail-help">
                    これは質問専用のゲートです。回答するとゲートはクローズされ、ブロックされていたチケットが着手可能になります。
                  </p>
                )}
                <button
                  type="button"
                  className="btn"
                  disabled={!canSubmitDecision || decisionMutation.isPending}
                  onClick={() => decisionMutation.mutate()}
                >
                  {decisionMutation.isPending ? '送信中…' : '回答を送信'}
                </button>
                {decisionMutation.error !== null && (
                  <p className="error-message">
                    {describeWriteError(
                      decisionMutation.error,
                      '回答の送信に失敗しました',
                    )}
                  </p>
                )}
              </div>
            )}
            {submittedDecision !== null &&
              (pendingDecision === undefined ||
                pendingDecision.id === submittedDecision.decisionId) && (
              <div className="detail-section">
                <h3>送信した回答</h3>
                {submittedDecision.choiceLabel !== undefined && (
                  <p className="detail-pre">{submittedDecision.choiceLabel}</p>
                )}
                {submittedDecision.freeform !== undefined && (
                  <p className="detail-pre">{submittedDecision.freeform}</p>
                )}
                <p className="detail-help">回答を送信しました</p>
                <p className="detail-help">
                  {submittedDecision.outcome.kind === 'unknown'
                    ? '種別(ゲート/作業チケット)を判定できませんでした。回答はコメントとして記録しましたが、確認待ちのまま残っています。しばらくしてからもう一度送信してください。'
                    : submittedDecision.outcome.closed
                      ? '確認用のゲートを解決しました。ブロックされていたチケットが次の更新で着手可能になります。'
                      : 'このチケットはクローズしていません。確認待ちから外れ、次の更新で通常のレーンに戻ります。'}
                </p>
              </div>
            )}
            <div className="detail-section">
              <div className="ticket-timeline-header">
                <h3>変更履歴</h3>
                <button
                  type="button"
                  className="btn ticket-timeline-toggle-btn"
                  onClick={() => setTimelineExpanded((expanded) => !expanded)}
                >
                  {timelineExpanded ? '閉じる' : '表示'}
                </button>
              </div>
              {timelineExpanded && timelineLoading && (
                <p className="loading">読み込み中…</p>
              )}
              {timelineExpanded && timelineError !== null && (
                <p className="error-message">
                  {timelineError instanceof Error
                    ? timelineError.message
                    : '変更履歴の読み込みに失敗しました'}
                </p>
              )}
              {timelineExpanded &&
                timelineEvents !== undefined &&
                timelineEvents.length === 0 && (
                  <p className="detail-help">変更履歴はありません</p>
                )}
              {timelineExpanded &&
                timelineEvents !== undefined &&
                timelineEvents.length > 0 && (
                  <div className="ticket-timeline-groups">
                    {groupEventsByDate(timelineEvents, new Date()).map((group) => (
                      <section key={group.heading} className="ticket-timeline-date-group">
                        <h4 className="ticket-timeline-date-heading">{group.heading}</h4>
                        <ul className="ticket-timeline-list">
                          {group.events.map((event) => {
                            const at = new Date(event.at);
                            const changeDetail = formatTimelineChangeDetail(
                              event.kind,
                              event.from,
                              event.to,
                            );
                            const secondaryParts = [
                              event.actor !== undefined ? `@${event.actor}` : undefined,
                              changeDetail,
                              event.reason,
                            ].filter(
                              (part): part is string =>
                                part !== undefined && part.length > 0,
                            );
                            const secondaryText =
                              secondaryParts.length > 0
                                ? secondaryParts.join(' · ')
                                : undefined;

                            return (
                              <li
                                key={`${event.kind}-${event.at}`}
                                className="ticket-timeline-item"
                              >
                                <span className="ticket-timeline-time">
                                  {formatActivityTime(at)}
                                </span>
                                <span className={timelineKindBadgeClass(event.kind)}>
                                  {ACTIVITY_KIND_LABELS[event.kind]}
                                </span>
                                {secondaryText !== undefined && (
                                  <span className="ticket-timeline-detail">
                                    {secondaryText}
                                  </span>
                                )}
                              </li>
                            );
                          })}
                        </ul>
                      </section>
                    ))}
                  </div>
                )}
            </div>
            <div className="detail-section">
              <h3>コメント</h3>
              {!commentsEnabled && (
                <p className="detail-help">コメントはありません</p>
              )}
              {commentsEnabled && commentsLoading && (
                <p className="loading">読み込み中…</p>
              )}
              {commentsEnabled && commentsError !== null && (
                <p className="error-message">
                  {commentsError instanceof Error
                    ? commentsError.message
                    : 'コメントの読み込みに失敗しました'}
                </p>
              )}
              {commentsEnabled &&
                !commentsLoading &&
                commentsError === null &&
                comments !== undefined &&
                comments.length === 0 && (
                  <p className="detail-help">コメントはありません</p>
                )}
              {commentsEnabled &&
                comments !== undefined &&
                comments.length > 0 && (
                  <ul className="comment-list">
                    {comments.map((comment) => (
                      <li key={comment.id} className="comment-item">
                        <div className="comment-meta">
                          <span className="comment-author">{comment.author}</span>
                          <time
                            className="comment-date"
                            dateTime={comment.createdAt}
                          >
                            {formatAbsoluteTime(comment.createdAt)}
                          </time>
                        </div>
                        <MarkdownContent
                          text={comment.text}
                          isTicketOnBoard={isTicketOnBoard}
                          onOpenTicket={onOpenTicket}
                          className="markdown-detail"
                        />
                      </li>
                    ))}
                  </ul>
                )}
              <form
                className="comment-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (!canSubmitComment || commentMutation.isPending) {
                    return;
                  }
                  commentMutation.mutate();
                }}
              >
                <label className="comment-form-label" htmlFor="comment-text">
                  コメントを追加
                </label>
                <textarea
                  ref={commentTextareaRef}
                  id="comment-text"
                  className="comment-form-input"
                  value={commentText}
                  onChange={(event) => setCommentText(event.target.value)}
                  rows={3}
                  maxLength={2000}
                  disabled={commentMutation.isPending}
                />
                <button
                  type="submit"
                  className="btn comment-form-submit"
                  disabled={!canSubmitComment || commentMutation.isPending}
                >
                  {commentMutation.isPending ? '送信中…' : 'コメントを投稿'}
                </button>
                {commentMutation.error !== null && (
                  <p className="error-message">
                    {describeWriteError(
                      commentMutation.error,
                      'コメントの投稿に失敗しました',
                    )}
                  </p>
                )}
              </form>
            </div>
            <div className="detail-section">
              <h3>クイックアクション</h3>
              <p className="detail-help">
                ローカル画面から bd コマンドを直接実行します(確認あり)
              </p>
              <div className="quick-action-buttons">
                <button
                  type="button"
                  className="btn quick-action-btn"
                  disabled={quickActionsDisabled}
                  onClick={() => setConfirmingQuickAction({ kind: 'claim' })}
                >
                  着手
                </button>
                <button
                  type="button"
                  className="btn quick-action-btn"
                  disabled={quickActionsDisabled}
                  onClick={() => setConfirmingQuickAction({ kind: 'close' })}
                >
                  完了
                </button>
                <div className="quick-action-defer-group">
                  <select
                    aria-label="延期期間"
                    value={deferPeriodKind}
                    onChange={(event) =>
                      setDeferPeriodKind(event.target.value as DeferPeriodKind)
                    }
                    disabled={quickActionsDisabled}
                  >
                    {DEFER_PERIOD_OPTIONS.map(({ kind, label }) => (
                      <option key={kind} value={kind}>
                        {label}
                      </option>
                    ))}
                  </select>
                  {deferPeriodKind === 'custom' && (
                    <input
                      type="date"
                      min={todayLocalDateInputValue()}
                      value={customDeferDate}
                      onChange={(event) => setCustomDeferDate(event.target.value)}
                      disabled={quickActionsDisabled}
                    />
                  )}
                  <button
                    type="button"
                    className="btn quick-action-btn"
                    disabled={quickActionsDisabled || deferSubmitDisabled}
                    onClick={handleDeferQuickAction}
                  >
                    延期
                  </button>
                </div>
                <button
                  type="button"
                  className="btn quick-action-btn"
                  disabled={quickActionsDisabled || !canRaisePriority}
                  onClick={() =>
                    setConfirmingQuickAction({
                      kind: 'priority',
                      priority: Math.max(0, data.priority - 1),
                    })
                  }
                >
                  優先度を上げる
                </button>
                <button
                  type="button"
                  className="btn quick-action-btn"
                  disabled={quickActionsDisabled || !canLowerPriority}
                  onClick={() =>
                    setConfirmingQuickAction({
                      kind: 'priority',
                      priority: Math.min(4, data.priority + 1),
                    })
                  }
                >
                  優先度を下げる
                </button>
              </div>
              {confirmingQuickAction !== null && (
                <div
                  ref={quickActionConfirmRef}
                  className="quick-action-confirm-panel"
                  role="alertdialog"
                  aria-labelledby="quick-action-confirm-title"
                  aria-describedby="quick-action-confirm-desc"
                >
                  <p
                    id="quick-action-confirm-title"
                    className="quick-action-confirm-title"
                  >
                    {formatQuickActionConfirmTitle(confirmingQuickAction)}
                  </p>
                  <p
                    id="quick-action-confirm-desc"
                    className="quick-action-confirm-desc"
                  >
                    {formatQuickActionConfirmDescription(confirmingQuickAction)}
                  </p>
                  {confirmingQuickAction.kind === 'close' && (
                    <>
                      <label
                        className="quick-action-reason-label"
                        htmlFor="quick-action-close-reason"
                      >
                        理由(任意)
                      </label>
                      <textarea
                        id="quick-action-close-reason"
                        className="quick-action-reason-input"
                        value={closeReason}
                        onChange={(event) => setCloseReason(event.target.value)}
                        rows={3}
                        maxLength={2000}
                        disabled={quickActionMutation.isPending}
                      />
                    </>
                  )}
                  <div className="quick-action-confirm-actions">
                    <button
                      ref={cancelQuickActionRef}
                      type="button"
                      className="btn quick-action-confirm-cancel"
                      onClick={handleCancelQuickAction}
                      disabled={quickActionMutation.isPending}
                    >
                      キャンセル
                    </button>
                    <button
                      type="button"
                      className="btn"
                      onClick={handleConfirmQuickAction}
                      disabled={quickActionMutation.isPending}
                    >
                      {quickActionMutation.isPending ? '実行中…' : '実行する'}
                    </button>
                  </div>
                </div>
              )}
              {quickActionMutation.error !== null && (
                <p className="error-message">
                  {describeWriteError(
                    quickActionMutation.error,
                    'クイックアクションの実行に失敗しました',
                  )}
                </p>
              )}
            </div>
            <div className="detail-section">
              <h3>エージェント実行</h3>
              {(polledRunDetail !== null ||
                activeRunMeta !== null ||
                runStatusUnavailable) && (
                <div className="agent-run-current">
                  {runStatusUnavailable && (
                    <p className="agent-run-status agent-run-status-unavailable">
                      状態を取得できません（実行状況の取得に失敗したため監視を停止しました）
                    </p>
                  )}
                  {polledRunDetail !== null && (
                    <p className="agent-run-status">
                      状態: {formatAgentRunStatus(polledRunDetail.status)}
                      {polledRunDetail.exitCode !== undefined &&
                        ` (終了コード: ${polledRunDetail.exitCode})`}
                      {polledRunDetail.error !== undefined &&
                        ` — ${polledRunDetail.error}`}
                    </p>
                  )}
                  {(activeRunMeta !== null || polledRunDetail !== null) && (
                    <dl className="agent-run-meta">
                      <div>
                        <dt>worktree</dt>
                        <dd>
                          {polledRunDetail?.cwd ??
                            activeRunMeta?.worktreePath ??
                            '—'}
                        </dd>
                      </div>
                      {activeRunMeta !== null && (
                        <div>
                          <dt>branch</dt>
                          <dd>{activeRunMeta.branchName}</dd>
                        </div>
                      )}
                      {activeRunMeta !== null && (
                        <div>
                          <dt>worktree の扱い</dt>
                          <dd>
                            {activeRunMeta.reused ? '既存を再利用' : '新規作成'}
                          </dd>
                        </div>
                      )}
                    </dl>
                  )}
                  {polledRunDetail?.nextStep !== undefined && (
                    <AgentRunNextStep
                      nextStep={polledRunDetail.nextStep}
                      target="next-step-current"
                      copied={
                        copyFeedback?.kind === 'success' &&
                        copyFeedback.command === 'next-step-current'
                      }
                      onCopy={(target, nextStep) =>
                        void handleCopyNextStep(target, nextStep)
                      }
                    />
                  )}
                  {polledRunDetail !== null &&
                    isAgentRunInProgress(polledRunDetail.status) && (
                      <button
                        type="button"
                        className="btn btn-small agent-run-cancel-btn"
                        disabled={
                          cancelRunMutation.isPending ||
                          polledRunDetail.status === 'cancelling'
                        }
                        onClick={() => cancelRunMutation.mutate()}
                      >
                        {cancelRunMutation.isPending ||
                        polledRunDetail.status === 'cancelling'
                          ? '中止中…'
                          : '中止'}
                      </button>
                    )}
                  {cancelRunMutation.error !== null && (
                    <p className="error-message">
                      {describeWriteError(
                        cancelRunMutation.error,
                        'エージェントの実行を中止できませんでした',
                      )}
                    </p>
                  )}
                  {polledRunDetail !== null &&
                    polledRunDetail.logRestricted === true && (
                      <p className="detail-help">{AGENT_RUN_LOG_LOCAL_ONLY_HELP}</p>
                    )}
                  {polledRunDetail !== null &&
                    polledRunDetail.logRestricted !== true &&
                    polledRunDetail.log.length > 0 && (
                      <details className="agent-run-log-details">
                        <summary>実行ログ</summary>
                        <pre className="agent-run-log-pre">{polledRunDetail.log}</pre>
                      </details>
                    )}
                </div>
              )}
              <h4 className="agent-run-history-heading">実行履歴</h4>
              {ticketRunsLoading && <p className="loading">読み込み中…</p>}
              {ticketRunsError !== null && (
                <p className="error-message">
                  {ticketRunsError instanceof Error
                    ? ticketRunsError.message
                    : '実行履歴の読み込みに失敗しました'}
                </p>
              )}
              {ticketRunsData !== undefined &&
                ticketRunsData.runs.length === 0 && (
                  <p className="detail-help">実行履歴はありません</p>
                )}
              {ticketRunsData !== undefined && ticketRunsData.runs.length > 0 && (
                <ul className="agent-run-history-list">
                  {ticketRunsData.runs.map((run) => (
                    <li key={run.id}>
                      <button
                        type="button"
                        className={`agent-run-history-btn${
                          selectedHistoryRunId === run.id ? ' is-selected' : ''
                        }`}
                        onClick={() => setSelectedHistoryRunId(run.id)}
                      >
                        <time dateTime={run.startedAt}>
                          {formatAbsoluteTime(run.startedAt)}
                        </time>
                        <span className="agent-run-history-status">
                          {formatAgentRunStatus(run.status)}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {selectedHistoryRunId !== null && selectedHistoryRunLoading && (
                <p className="loading">ログを読み込み中…</p>
              )}
              {selectedHistoryRunError !== null && (
                <p className="error-message">
                  {selectedHistoryRunError instanceof Error
                    ? selectedHistoryRunError.message
                    : '実行ログの読み込みに失敗しました'}
                </p>
              )}
              {selectedHistoryRun !== undefined && (
                <div className="agent-run-history-detail">
                  <dl className="agent-run-meta">
                    <div>
                      <dt>worktree</dt>
                      <dd>{selectedHistoryRun.cwd ?? '—'}</dd>
                    </div>
                  </dl>
                  {selectedHistoryRun.nextStep !== undefined && (
                    <AgentRunNextStep
                      nextStep={selectedHistoryRun.nextStep}
                      target="next-step-history"
                      copied={
                        copyFeedback?.kind === 'success' &&
                        copyFeedback.command === 'next-step-history'
                      }
                      onCopy={(target, nextStep) =>
                        void handleCopyNextStep(target, nextStep)
                      }
                    />
                  )}
                  <details className="agent-run-log-details" open>
                    <summary>実行ログ</summary>
                    {selectedHistoryRun.logRestricted === true ? (
                      <p className="detail-help">{AGENT_RUN_LOG_LOCAL_ONLY_HELP}</p>
                    ) : (
                      <pre className="agent-run-log-pre">
                        {selectedHistoryRun.log.length > 0
                          ? selectedHistoryRun.log
                          : '(ログなし)'}
                      </pre>
                    )}
                  </details>
                </div>
              )}
            </div>
            <div className="detail-section">
              <h3>bdコマンド</h3>
              <p className="detail-help">
                クリップボードにコピーしてターミナルで実行できます
              </p>
              <div className="bd-command-actions">
                {BD_COMMAND_DEFINITIONS.map(({ kind, label }) => {
                  const command = buildBdCommand(kind, data.id, projectRootPath);
                  const showSuccess =
                    copyFeedback?.kind === 'success' &&
                    copyFeedback.command === kind;

                  return (
                    <button
                      key={kind}
                      type="button"
                      className="btn bd-command-btn"
                      onClick={() => void handleCopyCommand(kind)}
                      aria-label={`${label}コマンドをコピー: ${command}`}
                    >
                      {showSuccess ? 'コピーしました' : label}
                    </button>
                  );
                })}
              </div>
              {copyFeedback?.kind === 'error' && (
                <p className="error-message">コピーできませんでした</p>
              )}
              <p className="sr-only" aria-live="polite">
                {ariaLiveMessage}
              </p>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
