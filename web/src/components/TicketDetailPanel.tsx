import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BD_COMMAND_DEFINITIONS,
  buildBdCommand,
  type BdCommandKind,
  copyTextToClipboard,
} from '../bdCommands';
import {
  cancelAgentRun,
  fetchAgentRun,
  fetchProjectHarnessStatus,
  fetchTicket,
  fetchTicketRuns,
  fetchTicketComments,
  fetchTicketTimeline,
  fetchSimilarTickets,
  fetchTicketInFlightOverlaps,
  postTicketDecision,
  startTicketRun,
  type AgentRunDetailDto,
  type AgentRunNextStepDto,
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
import { MarkdownContent } from './MarkdownContent';
import { PrLinkBadge } from './PrLinkBadge';
import { WatchToggle } from './WatchToggle';
import { TicketAttachments } from './TicketAttachments';
import { useUndoSnackbar } from './UndoSnackbar';

import { COPY_FEEDBACK_MS } from './ticket-detail/constants';
import {
  type TicketDetailPanelProps,
  type NextStepCopyTarget,
  type CopyDisplay,
  EMPTY_COPY_DISPLAY,
  type SubmittedDecision,
} from './ticket-detail/types';
import { formatDateTime } from './ticket-detail/formatters';
import {
  AGENT_RUN_LOG_LOCAL_ONLY_HELP,
  computeRunStartDisabled,
  AGENT_RUN_NEXT_STEP_LABEL,
  formatAgentRunStatus,
} from './ticket-detail/agentRun';
import { AgentRunNextStep } from './ticket-detail/AgentRunNextStep';
import { TicketIdLink } from './ticket-detail/TicketIdLink';
import { TicketTimelineSection } from './ticket-detail/TicketTimelineSection';
import { TicketCommentsSection } from './ticket-detail/TicketCommentsSection';
import { TicketInFlightOverlapsSection } from './ticket-detail/TicketInFlightOverlapsSection';
import { TicketSimilarTicketsSection } from './ticket-detail/TicketSimilarTicketsSection';
import { useTicketTitleEditing } from './ticket-detail/useTicketTitleEditing';
import { TicketTitleSection } from './ticket-detail/TicketTitleSection';
import { useTicketDescriptionEditing } from './ticket-detail/useTicketDescriptionEditing';
import { TicketDescriptionSection } from './ticket-detail/TicketDescriptionSection';
import { useTicketLabels } from './ticket-detail/useTicketLabels';
import { TicketLabelsSection } from './ticket-detail/TicketLabelsSection';
import { useTicketDependencies } from './ticket-detail/useTicketDependencies';
import { TicketDependenciesSection } from './ticket-detail/TicketDependenciesSection';
import { TicketModelsSection } from './ticket-detail/TicketModelsSection';
import { TicketUsageSection } from './ticket-detail/TicketUsageSection';
import { TicketChildrenSection } from './ticket-detail/TicketChildrenSection';
import { TicketBdCommandSection } from './ticket-detail/TicketBdCommandSection';
import { useTicketComment } from './ticket-detail/useTicketComment';
import { useTicketSessionLink } from './ticket-detail/useTicketSessionLink';
import { TicketSessionLinkSection } from './ticket-detail/TicketSessionLinkSection';
import { useTicketQuickActions } from './ticket-detail/useTicketQuickActions';
import { TicketQuickActionsSection } from './ticket-detail/TicketQuickActionsSection';

export type { TicketDetailPanelProps };
export { AGENT_RUN_LOG_LOCAL_ONLY_HELP, AGENT_RUN_NEXT_STEP_LABEL };

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
  const quickActions = useTicketQuickActions(ticketId, data, undoSnackbar);
  const {
    titleEditing,
    titleDraft,
    canSaveTitle,
    isSaving: isTitleSaving,
    error: titleEditingError,
    setTitleDraft,
    handleStartTitleEdit,
    handleCancelTitleEdit,
    handleSaveTitle,
    reset: resetTitleEditing,
  } = useTicketTitleEditing(ticketId, data?.title);
  const {
    descriptionEditing,
    descriptionDraft,
    canSaveDescription,
    isSaving: isDescriptionSaving,
    error: descriptionEditingError,
    setDescriptionDraft,
    handleStartDescriptionEdit,
    handleCancelDescriptionEdit,
    handleSaveDescription,
    reset: resetDescriptionEditing,
  } = useTicketDescriptionEditing(ticketId, data !== undefined, data?.description);
  const currentLabels = data?.labels ?? [];
  const {
    labelInputQuery,
    setLabelInputQuery,
    trimmedLabelInput,
    labelSuggestions,
    canSubmitLabel,
    labelMutationPending,
    isAddPending: isAddLabelPending,
    error: labelMutationError,
    handleAddLabel,
    handleRemoveLabel,
    reset: resetLabelInput,
  } = useTicketLabels(ticketId, currentLabels, availableLabels);
  const {
    dependencySearchQuery,
    setDependencySearchQuery,
    hasDependencySearchQuery,
    dependencySearchLoading,
    dependencySearchError,
    dependencyCandidates,
    dependencyMutationPending,
    error: dependencyMutationError,
    handleAddDependency,
    handleRemoveDependency,
    reset: resetDependencies,
  } = useTicketDependencies(ticketId, data);
  const {
    commentText,
    setCommentText,
    canSubmitComment,
    mutation: commentMutation,
    reset: resetComment,
  } = useTicketComment(ticketId);
  const {
    sessionLinkPickerOpen,
    togglePicker: toggleSessionLinkPicker,
    isLoadingSessions,
    activeSessionCandidates,
    sessionLinkMutationPending,
    sessionLinkMutationError,
    onLinkSession,
    onUnlinkSession,
    reset: resetSessionLink,
  } = useTicketSessionLink(ticketId);
  const prevCommentCountRef = useRef<number | undefined>(undefined);
  const panelRef = useRef<HTMLDivElement>(null);
  const commentTextareaRef = useRef<HTMLTextAreaElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const cancelAgentRunConfirmRef = useRef<HTMLButtonElement>(null);
  const agentRunConfirmRef = useRef<HTMLDivElement>(null);
  const projectRootPath =
    data === undefined ? undefined : projectRootPaths.get(data.projectId);

  // 質問への回答欄だけを初期化する。resetFormState はこれを含む全体リセット。
  const resetDecisionAnswer = useCallback(() => {
    setSelectedChoice(undefined);
    setFreeformText('');
  }, []);

  const resetQuickActions = quickActions.reset;
  const resetFormState = useCallback((options?: { clearSubmittedDecision?: boolean }) => {
    clearCopyDisplay();
    resetDecisionAnswer();
    if (options?.clearSubmittedDecision === true) {
      setSubmittedDecision(null);
    }
    resetQuickActions();
    resetComment();
    resetDependencies();
    resetLabelInput();
    resetTitleEditing();
    resetDescriptionEditing();
    resetSessionLink();
    setConfirmingAgentRun(false);
    setActiveRunId(null);
    setActiveRunMeta(null);
    setPolledRunDetail(null);
    setSelectedHistoryRunId(null);
  }, [
    clearCopyDisplay,
    resetQuickActions,
    resetComment,
    resetDecisionAnswer,
    resetDependencies,
    resetDescriptionEditing,
    resetLabelInput,
    resetSessionLink,
    resetTitleEditing,
  ]);

  useEffect(() => {
    resetFormState({ clearSubmittedDecision: true });
  }, [ticketId, projectRootPath, resetFormState]);

  useFocusTrap({
    containerRef: panelRef,
    initialFocusRef: closeButtonRef,
    onEscape: onClose,
    enabled: quickActions.confirmingQuickAction === null && !confirmingAgentRun,
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

  const quickActionsDisabled =
    quickActions.mutationPending ||
    quickActions.confirmingQuickAction !== null ||
    confirmingAgentRun ||
    startRunMutation.isPending;
  const agentRunActionsDisabled =
    startRunMutation.isPending ||
    quickActions.confirmingQuickAction !== null ||
    confirmingAgentRun;

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
          if (quickActions.confirmingQuickAction !== null || confirmingAgentRun) {
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
          <TicketTitleSection
            title={data?.title}
            hasData={data !== undefined}
            isLoading={isLoading}
            titleEditing={titleEditing}
            titleDraft={titleDraft}
            onTitleDraftChange={setTitleDraft}
            canSaveTitle={canSaveTitle}
            isSaving={isTitleSaving}
            error={titleEditingError}
            onStartTitleEdit={handleStartTitleEdit}
            onCancelTitleEdit={handleCancelTitleEdit}
            onSaveTitle={handleSaveTitle}
          />
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
            <TicketLabelsSection
              currentLabels={currentLabels}
              labelInputQuery={labelInputQuery}
              onLabelInputQueryChange={setLabelInputQuery}
              trimmedLabelInput={trimmedLabelInput}
              labelSuggestions={labelSuggestions}
              canSubmitLabel={canSubmitLabel}
              labelMutationPending={labelMutationPending}
              isAddPending={isAddLabelPending}
              error={labelMutationError}
              onAddLabel={handleAddLabel}
              onRemoveLabel={handleRemoveLabel}
            />
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
            <TicketChildrenSection
              children={data.children}
              isTicketOnBoard={isTicketOnBoard}
              onOpenTicket={onOpenTicket}
              onFilterByEpic={() => onFilterByEpic(data.id)}
            />
            <TicketInFlightOverlapsSection
              enabled={inFlightOverlapsEnabled}
              error={inFlightOverlapsError}
              overlaps={inFlightOverlaps}
              isTicketOnBoard={isTicketOnBoard}
              onOpenTicket={onOpenTicket}
            />
            <TicketSimilarTicketsSection
              loading={similarTicketsLoading}
              error={similarTicketsError}
              tickets={similarTickets}
              isTicketOnBoard={isTicketOnBoard}
              onOpenTicket={onOpenTicket}
            />
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
            <TicketDescriptionSection
              description={data.description}
              descriptionEditing={descriptionEditing}
              descriptionDraft={descriptionDraft}
              onDescriptionDraftChange={setDescriptionDraft}
              canSaveDescription={canSaveDescription}
              isSaving={isDescriptionSaving}
              error={descriptionEditingError}
              onStartDescriptionEdit={handleStartDescriptionEdit}
              onCancelDescriptionEdit={handleCancelDescriptionEdit}
              onSaveDescription={handleSaveDescription}
              isTicketOnBoard={isTicketOnBoard}
              onOpenTicket={onOpenTicket}
            />
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
            <TicketDependenciesSection
              dependencies={data.dependencies}
              isTicketOnBoard={isTicketOnBoard}
              onOpenTicket={onOpenTicket}
              dependencyMutationPending={dependencyMutationPending}
              onRemoveDependency={handleRemoveDependency}
              dependencySearchQuery={dependencySearchQuery}
              onDependencySearchQueryChange={setDependencySearchQuery}
              hasDependencySearchQuery={hasDependencySearchQuery}
              dependencySearchLoading={dependencySearchLoading}
              dependencySearchError={dependencySearchError}
              dependencyCandidates={dependencyCandidates}
              onAddDependency={handleAddDependency}
              error={dependencyMutationError}
            />
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
            <TicketModelsSection models={data.models} />
            <TicketSessionLinkSection
              sessionLinks={data.sessionLinks}
              pickerOpen={sessionLinkPickerOpen}
              onTogglePicker={toggleSessionLinkPicker}
              isLoadingSessions={isLoadingSessions}
              activeSessionCandidates={activeSessionCandidates}
              mutationPending={sessionLinkMutationPending}
              mutationError={sessionLinkMutationError}
              onLinkSession={onLinkSession}
              onUnlinkSession={onUnlinkSession}
            />
            <TicketUsageSection usage={data.usage} />
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
                {/*
                 * bdboard-q1k9: ambiguousGateIds が返ってきた場合、このチケットは
                 * 2件以上の独立した human gate にブロックされていて、どの質問への
                 * 回答か特定できず respond() は何も resolve していない(human ラベルも
                 * 外れていない)。closed は常に false のまま同じなので、下の通常分岐
                 * (「確認待ちから外れ、次の更新で通常のレーンに戻ります」)をそのまま
                 * 出すと実際には何も変わっていないのに解決したかのように誤読させる
                 * (bdboard-v78e)。この分岐を優先し、個別の gate へ回答するよう促す。
                 * kind/closed との整合性(kind==='ticket' かつ closed===false のとき
                 * だけ設定される、配列は非空)は web/src/api.ts の
                 * mapTicketDecisionOutcome 側で強制済みなので、ここでは
                 * ambiguousGateIds の有無だけを見ればよい。
                 */}
                {submittedDecision.outcome.ambiguousGateIds !== undefined ? (
                  <>
                    <p className="detail-help">
                      このチケットは複数の質問(gate)に分かれています。どの質問への回答か特定できなかったため、回答はコメントとして記録しましたが、gate の解決と確認待ちの解除は行っていません。このチケットは確認待ちのまま残ります。下の gate を開いて個別に回答してください。
                    </p>
                    {/*
                     * bdboard-v78e レビュー指摘: gate はエピック絞り込みの対象外
                     * (parentId を持たない)なので、絞り込み中は isTicketOnBoard(gateId)
                     * が false になり TicketIdLink が非クリック化してしまう
                     * (「現在のボードに表示されていません」)。ここで列挙する gate ID は
                     * ユーザーが自由入力したテキストからの自動リンクではなく respond()
                     * のレスポンスに含まれるサーバー由来の確定 ID なので、盤面フィルタの
                     * 状態に関わらず常にクリック可能にする(TicketIdLink は使わない)。
                     */}
                    <ul className="detail-list">
                      {submittedDecision.outcome.ambiguousGateIds.map((gateId) => (
                        <li key={gateId}>
                          <button
                            type="button"
                            className="ticket-id-link"
                            onClick={() => onOpenTicket(gateId)}
                          >
                            {gateId}
                          </button>
                        </li>
                      ))}
                    </ul>
                  </>
                ) : (
                  <p className="detail-help">
                    {submittedDecision.outcome.kind === 'unknown'
                      ? '種別(ゲート/作業チケット)を判定できませんでした。回答はコメントとして記録しましたが、確認待ちのまま残っています。しばらくしてからもう一度送信してください。'
                      : submittedDecision.outcome.closed
                        ? '確認用のゲートを解決しました。ブロックされていたチケットが次の更新で着手可能になります。'
                        : 'このチケットはクローズしていません。確認待ちから外れ、次の更新で通常のレーンに戻ります。'}
                  </p>
                )}
              </div>
            )}
            <TicketTimelineSection
              expanded={timelineExpanded}
              onToggleExpanded={() =>
                setTimelineExpanded((expanded) => !expanded)
              }
              loading={timelineLoading}
              error={timelineError}
              events={timelineEvents}
            />
            <TicketAttachments ticketId={ticketId} />
            <TicketCommentsSection
              enabled={commentsEnabled}
              loading={commentsLoading}
              error={commentsError}
              comments={comments}
              isTicketOnBoard={isTicketOnBoard}
              onOpenTicket={onOpenTicket}
              textareaRef={commentTextareaRef}
              commentText={commentText}
              onCommentTextChange={setCommentText}
              canSubmit={canSubmitComment}
              mutation={commentMutation}
            />
            <TicketQuickActionsSection
              priority={data.priority}
              confirmingQuickAction={quickActions.confirmingQuickAction}
              onSetConfirmingQuickAction={quickActions.setConfirmingQuickAction}
              quickActionsDisabled={quickActionsDisabled}
              deferPeriodKind={quickActions.deferPeriodKind}
              onDeferPeriodKindChange={quickActions.setDeferPeriodKind}
              customDeferDate={quickActions.customDeferDate}
              onCustomDeferDateChange={quickActions.setCustomDeferDate}
              deferSubmitDisabled={quickActions.deferSubmitDisabled}
              onDeferQuickAction={quickActions.handleDeferQuickAction}
              canRaisePriority={quickActions.canRaisePriority}
              canLowerPriority={quickActions.canLowerPriority}
              quickActionConfirmRef={quickActions.quickActionConfirmRef}
              cancelQuickActionRef={quickActions.cancelQuickActionRef}
              onCancelQuickAction={quickActions.handleCancelQuickAction}
              closeReason={quickActions.closeReason}
              onCloseReasonChange={quickActions.setCloseReason}
              mutationPending={quickActions.mutationPending}
              onConfirmQuickAction={quickActions.handleConfirmQuickAction}
              mutationError={quickActions.mutationError}
            />
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
            <TicketBdCommandSection
              ticketId={data.id}
              projectRootPath={projectRootPath}
              copyFeedback={copyFeedback}
              ariaLiveMessage={ariaLiveMessage}
              onCopyCommand={(kind) => void handleCopyCommand(kind)}
            />
          </>
        )}
      </div>
    </div>
  );
}
