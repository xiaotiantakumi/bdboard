import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  BD_COMMAND_DEFINITIONS,
  buildBdCommand,
  type BdCommandKind,
  copyTextToClipboard,
  formatDeferDate,
} from '../bdCommands';
import {
  deleteTicketDependency,
  deleteTicketSessionLink,
  fetchSessions,
  fetchTicket,
  fetchTicketComments,
  fetchTicketTimeline,
  postTicketComment,
  postTicketDecision,
  postTicketDependency,
  postTicketQuickAction,
  postTicketQuickActionUndo,
  postTicketSessionLink,
  searchTickets,
  type PendingDecisionDto,
  type PrBadgeDto,
  type QuickActionRequest,
  type SessionDto,
  type ActivityEventDto,
  type TicketSearchResultDto,
  LANE_LABELS,
} from '../api';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { describeWriteError } from '../writeAccessMessage';
import { planQuickActionUndo } from '../quickActionUndo';
import {
  describeDependencyError,
  filterDependencyCandidates,
} from './dependencyEditing';
import { MarkdownContent } from './MarkdownContent';
import { PrLinkBadge } from './PrLinkBadge';
import { useUndoSnackbar } from './UndoSnackbar';
import {
  ACTIVITY_KIND_LABELS,
  formatActivityTime,
  groupEventsByDate,
} from './activityFeedFormatting';

const DEPENDENCY_SEARCH_DEBOUNCE_MS = 200;
const DEPENDENCY_SEARCH_LIMIT = 20;

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

interface TicketDetailPanelProps {
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
  isTicketOnBoard: (ticketId: string) => boolean;
  onFilterByEpic: (ticketId: string) => void;
}

type CopyFeedback =
  | { kind: 'success'; command: BdCommandKind }
  | { kind: 'error' };

type ConfirmingQuickAction =
  | { kind: 'claim' }
  | { kind: 'close' }
  | { kind: 'defer'; untilDate: string }
  | { kind: 'priority'; priority: number };

type SubmittedDecision = {
  decisionId: string;
  choiceLabel?: string;
  freeform?: string;
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
  return new Date(value).toLocaleString();
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
  isTicketOnBoard,
  onFilterByEpic,
}: TicketDetailPanelProps) {
  const queryClient = useQueryClient();
  const undoSnackbar = useUndoSnackbar();
  const { data, isLoading, error } = useQuery({
    queryKey: ['ticket', ticketId],
    queryFn: () => fetchTicket(ticketId),
  });
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
  const [copyFeedback, setCopyFeedback] = useState<CopyFeedback | null>(null);
  const [ariaLiveMessage, setAriaLiveMessage] = useState('');
  const [selectedChoice, setSelectedChoice] = useState<string | undefined>(
    undefined,
  );
  const [freeformText, setFreeformText] = useState('');
  const [confirmingQuickAction, setConfirmingQuickAction] =
    useState<ConfirmingQuickAction | null>(null);
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
  const [sessionLinkPickerOpen, setSessionLinkPickerOpen] = useState(false);
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevCommentCountRef = useRef<number | undefined>(undefined);
  const panelRef = useRef<HTMLElement>(null);
  const commentTextareaRef = useRef<HTMLTextAreaElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const cancelQuickActionRef = useRef<HTMLButtonElement>(null);
  const quickActionConfirmRef = useRef<HTMLDivElement>(null);
  const projectRootPath =
    data === undefined ? undefined : projectRootPaths.get(data.projectId);

  const resetFormState = useCallback((options?: { clearSubmittedDecision?: boolean }) => {
    setCopyFeedback(null);
    setAriaLiveMessage('');
    setSelectedChoice(undefined);
    setFreeformText('');
    if (options?.clearSubmittedDecision === true) {
      setSubmittedDecision(null);
    }
    setConfirmingQuickAction(null);
    setCloseReason('');
    setCommentText('');
    setDependencySearchQuery('');
    setDependencyCandidates([]);
    setDependencySearchLoading(false);
    setDependencySearchError(null);
    setSessionLinkPickerOpen(false);
    if (copyTimeoutRef.current !== null) {
      clearTimeout(copyTimeoutRef.current);
      copyTimeoutRef.current = null;
    }
  }, []);

  useEffect(() => {
    resetFormState({ clearSubmittedDecision: true });
  }, [ticketId, projectRootPath, resetFormState]);

  // submittedDecision は pendingDecision 切り替えでは消さない。回答直後に
  // 「送信した回答」セクションが消えると bdboard-50n の元バグに戻るため。
  useEffect(() => {
    resetFormState();
  }, [pendingDecision?.id, resetFormState]);

  useFocusTrap({
    containerRef: panelRef,
    initialFocusRef: closeButtonRef,
    onEscape: onClose,
    enabled: confirmingQuickAction === null,
  });

  const handleCancelQuickAction = useCallback(() => {
    setConfirmingQuickAction(null);
    setCloseReason('');
  }, []);

  useFocusTrap({
    containerRef: quickActionConfirmRef,
    initialFocusRef: cancelQuickActionRef,
    enabled: confirmingQuickAction !== null,
    onEscape: handleCancelQuickAction,
  });

  useEffect(() => {
    return () => {
      if (copyTimeoutRef.current !== null) {
        clearTimeout(copyTimeoutRef.current);
      }
    };
  }, []);

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
      if (copyTimeoutRef.current !== null) {
        clearTimeout(copyTimeoutRef.current);
        copyTimeoutRef.current = null;
      }

      const command = buildBdCommand(kind, ticketId, projectRootPath);
      const definition = BD_COMMAND_DEFINITIONS.find((entry) => entry.kind === kind);

      try {
        await copyTextToClipboard(command);
        setCopyFeedback({ kind: 'success', command: kind });
        setAriaLiveMessage(
          `${definition?.label ?? 'コマンド'}をコピーしました`,
        );
        copyTimeoutRef.current = setTimeout(() => {
          setCopyFeedback(null);
          setAriaLiveMessage('');
          copyTimeoutRef.current = null;
        }, COPY_FEEDBACK_MS);
      } catch (copyError) {
        console.error('Failed to copy bd command', copyError);
        setCopyFeedback({ kind: 'error' });
        setAriaLiveMessage('コピーできませんでした');
        copyTimeoutRef.current = setTimeout(() => {
          setCopyFeedback(null);
          setAriaLiveMessage('');
          copyTimeoutRef.current = null;
        }, COPY_FEEDBACK_MS);
      }
    },
    [projectRootPath, ticketId],
  );

  const trimmedFreeform = freeformText.trim();
  const canSubmitDecision =
    selectedChoice !== undefined || trimmedFreeform.length > 0;

  const decisionMutation = useMutation({
    mutationFn: async () => {
      if (pendingDecision === undefined) {
        throw new Error('pending decision is not available');
      }

      await postTicketDecision(pendingDecision.id, {
        ...(selectedChoice !== undefined ? { choice: selectedChoice } : {}),
        ...(trimmedFreeform.length > 0 ? { freeform: trimmedFreeform } : {}),
      });
    },
    onSuccess: async () => {
      if (pendingDecision !== undefined) {
        const choiceLabel =
          selectedChoice !== undefined
            ? pendingDecision.options?.find(
                (option) => option.value === selectedChoice,
              )?.label
            : undefined;
        setSubmittedDecision({
          decisionId: pendingDecision.id,
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

    setDependencySearchLoading(true);
    setDependencySearchError(null);

    const handle = window.setTimeout(() => {
      void searchTickets(trimmedDependencySearchQuery, DEPENDENCY_SEARCH_LIMIT)
        .then((hits) => {
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
          setDependencySearchError(
            caught instanceof Error ? caught : new Error('検索に失敗しました'),
          );
          setDependencyCandidates([]);
          setDependencySearchLoading(false);
        });
    }, DEPENDENCY_SEARCH_DEBOUNCE_MS);

    return () => {
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

  const dependencyMutationPending =
    addDependencyMutation.isPending || removeDependencyMutation.isPending;
  const dependencyMutationError =
    addDependencyMutation.error ?? removeDependencyMutation.error;

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
    quickActionMutation.isPending || confirmingQuickAction !== null;

  return (
    <div
      className="overlay"
      onClick={onClose}
      role="presentation"
    >
      <aside
        ref={panelRef}
        className="detail-panel"
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
          if (confirmingQuickAction !== null) {
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
        <div className="detail-header">
          <h2 id="detail-title" className="detail-title">
            {isLoading ? '読み込み中…' : data?.title ?? 'チケット詳細'}
          </h2>
          <button
            ref={closeButtonRef}
            type="button"
            className="btn detail-close"
            onClick={onClose}
          >
            閉じる
          </button>
        </div>

        {isLoading && <p className="loading">読み込み中…</p>}
        {error !== null && (
          <p className="error-message">
            {error instanceof Error ? error.message : '読み込みに失敗しました'}
          </p>
        )}
        {data !== undefined && (
          <>
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
            {data.description !== undefined && (
              <div className="detail-section">
                <h3>Description</h3>
                <MarkdownContent
                  text={data.description}
                  isTicketOnBoard={isTicketOnBoard}
                  onOpenTicket={onOpenTicket}
                  className="markdown-detail"
                />
              </div>
            )}
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
                            {new Date(comment.createdAt).toLocaleString()}
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
                <button
                  type="button"
                  className="btn quick-action-btn"
                  disabled={quickActionsDisabled}
                  onClick={() =>
                    setConfirmingQuickAction({
                      kind: 'defer',
                      untilDate: formatDeferDate(),
                    })
                  }
                >
                  1週間延期
                </button>
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
      </aside>
    </div>
  );
}
