import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  BD_COMMAND_DEFINITIONS,
  buildBdCommand,
  type BdCommandKind,
  copyTextToClipboard,
} from '../bdCommands';
import {
  fetchTicket,
  fetchTicketComments,
  fetchTicketTimeline,
  fetchSimilarTickets,
  fetchTicketInFlightOverlaps,
  type AgentRunNextStepDto,
} from '../api';
import { useAutoClearedValue } from '../hooks/useAutoClearedValue';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { buildRunNextStepCommand } from './agentRunShared';
import {
  SidePanelResizeHandle,
  useResizableSidePanel,
} from '../hooks/useResizableSidePanel';
import { UI_STORAGE_KEYS } from '../uiPersistedState';
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
} from './ticket-detail/types';
import { formatDateTime } from './ticket-detail/formatters';
import {
  AGENT_RUN_LOG_LOCAL_ONLY_HELP,
  AGENT_RUN_NEXT_STEP_LABEL,
} from './ticket-detail/agentRun';
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
import { useTicketAgentRun } from './ticket-detail/useTicketAgentRun';
import {
  TicketAgentRunTrigger,
  TicketAgentRunConfirm,
} from './ticket-detail/TicketAgentRunTriggerSection';
import { TicketAgentRunSection } from './ticket-detail/TicketAgentRunSection';
import { useTicketDecisionAnswer } from './ticket-detail/useTicketDecisionAnswer';
import { TicketDecisionSection } from './ticket-detail/TicketDecisionSection';
import { useTicketFormReset } from './ticket-detail/useTicketFormReset';

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

  // agentRun (下) の ticketId/projectRootPath 変更リセットが内部の同期effectより
  // 先に走る順序を保証するため、agentRun 呼び出しより前で確定させておく
  // (bdboard-sso1.5 PR-L Opus レビュー対応、useTicketAgentRun.ts 冒頭コメント参照)。
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
  const agentRun = useTicketAgentRun(ticketId, data, projectRootPath);
  // bdboard-ty72: コピー表示は copyTextToClipboard の継続から出るので、素の
  // setTimeout だとアンマウント後にタイマーを仕掛けうる。
  const {
    value: copyDisplay,
    show: showCopyDisplay,
    clear: clearCopyDisplay,
  } = useAutoClearedValue<CopyDisplay>(EMPTY_COPY_DISPLAY, COPY_FEEDBACK_MS);
  const copyFeedback = copyDisplay.feedback;
  const ariaLiveMessage = copyDisplay.aria;
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

  // ticketId/projectRootPath 変更時の各セクション横断リセットは
  // useTicketFormReset.ts に抽出済み (bdboard-sso1.5)。agentRun は含まない
  // (useTicketAgentRun が自前でリセットを持つ理由はそのフック冒頭のコメント参照)。
  useTicketFormReset({
    ticketId,
    projectRootPath,
    clearCopyDisplay,
    resetDecision: decision.reset,
    resetQuickActions: quickActions.reset,
    resetComment,
    resetDependencies,
    resetLabelInput,
    resetTitleEditing,
    resetDescriptionEditing,
    resetSessionLink,
  });

  useFocusTrap({
    containerRef: panelRef,
    initialFocusRef: closeButtonRef,
    onEscape: onClose,
    enabled: quickActions.confirmingQuickAction === null && !agentRun.confirmingAgentRun,
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

  const quickActionsDisabled =
    quickActions.mutationPending ||
    quickActions.confirmingQuickAction !== null ||
    agentRun.confirmingAgentRun ||
    agentRun.startRunMutation.isPending;
  const agentRunActionsDisabled =
    agentRun.startRunMutation.isPending ||
    quickActions.confirmingQuickAction !== null ||
    agentRun.confirmingAgentRun;

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
          if (quickActions.confirmingQuickAction !== null || agentRun.confirmingAgentRun) {
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
              <TicketAgentRunTrigger
                agentRunActionsDisabled={agentRunActionsDisabled}
                runStartDisabled={agentRun.runStartDisabled}
                harnessRunBlockReason={agentRun.harnessRunBlockReason}
                hasActiveRun={agentRun.hasActiveRun}
                onStartConfirm={() => agentRun.setConfirmingAgentRun(true)}
              />
            </div>
            <TicketAgentRunConfirm
              ticketId={ticketId}
              confirmingAgentRun={agentRun.confirmingAgentRun}
              agentRunConfirmRef={agentRun.agentRunConfirmRef}
              cancelAgentRunConfirmRef={agentRun.cancelAgentRunConfirmRef}
              onCancelAgentRun={agentRun.handleCancelAgentRun}
              onStartRun={() => agentRun.startRunMutation.mutate()}
              startRunPending={agentRun.startRunMutation.isPending}
              startRunError={agentRun.startRunMutation.error}
            />
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
            <TicketDecisionSection
              pendingDecision={pendingDecision}
              selectedChoice={decision.selectedChoice}
              onSelectChoice={decision.setSelectedChoice}
              freeformText={decision.freeformText}
              onFreeformTextChange={decision.setFreeformText}
              canSubmitDecision={decision.canSubmitDecision}
              decisionMutation={decision.decisionMutation}
              submittedDecision={decision.submittedDecision}
              onOpenTicket={onOpenTicket}
            />
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
            <TicketAgentRunSection
              polledRunDetail={agentRun.polledRunDetail}
              activeRunMeta={agentRun.activeRunMeta}
              runStatusUnavailable={agentRun.runStatusUnavailable}
              copyFeedback={copyFeedback}
              onCopyNextStep={(target, nextStep) =>
                void handleCopyNextStep(target, nextStep)
              }
              cancelRunMutation={agentRun.cancelRunMutation}
              ticketRunsLoading={agentRun.ticketRunsLoading}
              ticketRunsError={agentRun.ticketRunsError}
              ticketRunsData={agentRun.ticketRunsData}
              selectedHistoryRunId={agentRun.selectedHistoryRunId}
              onSelectHistoryRun={agentRun.setSelectedHistoryRunId}
              selectedHistoryRunLoading={agentRun.selectedHistoryRunLoading}
              selectedHistoryRunError={agentRun.selectedHistoryRunError}
              selectedHistoryRun={agentRun.selectedHistoryRun}
            />
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
