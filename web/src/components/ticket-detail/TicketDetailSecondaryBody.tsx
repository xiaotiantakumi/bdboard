// bdboard-sso1.5: TicketDetailPanel.tsx の本体JSX(data確定後に並ぶセクション群)の
// 後半を、表示専用コンポーネントとして切り出した。state/effect/query は一切
// 持たず、useTicketDetailController.ts が返すグループ化済みオブジェクトと
// 素通しの props をそのまま各 Section コンポーネントへ配線するだけ
// (JSX・DOM構造・文言は移動前と同一)。前半は TicketDetailBody.tsx。
import type { RefObject } from 'react';
import type { PendingDecisionDto, TicketDetailDto } from '../../api';
import { TicketIdListSection } from './TicketIdListSection';
import { TicketDependenciesSection } from './TicketDependenciesSection';
import { TicketModelsSection } from './TicketModelsSection';
import { TicketSessionLinkSection } from './TicketSessionLinkSection';
import { TicketUsageSection } from './TicketUsageSection';
import { TicketDecisionSection } from './TicketDecisionSection';
import { TicketTimelineSection } from './TicketTimelineSection';
import { TicketAttachments } from '../TicketAttachments';
import { TicketCommentsSection } from './TicketCommentsSection';
import { TicketQuickActionsSection } from './TicketQuickActionsSection';
import { TicketAgentRunSection } from './TicketAgentRunSection';
import { TicketBdCommandSection } from './TicketBdCommandSection';
import type { useTicketDetailController } from './useTicketDetailController';

type Controller = ReturnType<typeof useTicketDetailController>;

export interface TicketDetailSecondaryBodyProps {
  data: TicketDetailDto;
  ticketId: string;
  projectRootPath: string | undefined;
  pendingDecision: PendingDecisionDto | undefined;
  isTicketOnBoard: (ticketId: string) => boolean;
  onOpenTicket: (ticketId: string) => void;
  dependencies: Controller['dependencies'];
  sessionLink: Controller['sessionLink'];
  decision: Controller['decision'];
  timeline: Controller['timeline'];
  comment: Controller['comment'];
  quickActions: Controller['quickActions'];
  agentRun: Controller['agentRun'];
  copy: Controller['copy'];
  commentTextareaRef: RefObject<HTMLTextAreaElement | null>;
}

export function TicketDetailSecondaryBody({
  data,
  ticketId,
  projectRootPath,
  pendingDecision,
  isTicketOnBoard,
  onOpenTicket,
  dependencies,
  sessionLink,
  decision,
  timeline,
  comment,
  quickActions,
  agentRun,
  copy,
  commentTextareaRef,
}: TicketDetailSecondaryBodyProps) {
  // bdboard-u6hf レビュー指摘: このセクションは pendingDecision の有無で2つの
  // JSX 位置のどちらかにだけ出る(同じ fragment の子として)。key を付けないと
  // 位置が変わるたびに unmount/remount され、ライトボックスの開閉状態が失われ、
  // 添付一覧が再フェッチされる。key を固定することで React が同一インスタンスの
  // 移動として扱い、状態を保持する。
  const attachmentsSection = (
    <TicketAttachments key="attachments" ticketId={ticketId} />
  );

  return (
    <>
      <TicketDependenciesSection
        dependencies={data.dependencies}
        isTicketOnBoard={isTicketOnBoard}
        onOpenTicket={onOpenTicket}
        dependencyMutationPending={dependencies.dependencyMutationPending}
        onRemoveDependency={dependencies.handleRemoveDependency}
        dependencySearchQuery={dependencies.dependencySearchQuery}
        onDependencySearchQueryChange={dependencies.setDependencySearchQuery}
        hasDependencySearchQuery={dependencies.hasDependencySearchQuery}
        dependencySearchLoading={dependencies.dependencySearchLoading}
        dependencySearchError={dependencies.dependencySearchError}
        dependencyCandidates={dependencies.dependencyCandidates}
        onAddDependency={dependencies.handleAddDependency}
        error={dependencies.error}
      />
      <TicketIdListSection
        heading="Blocked By"
        ids={data.blockedBy}
        isTicketOnBoard={isTicketOnBoard}
        onOpenTicket={onOpenTicket}
      />
      <TicketIdListSection
        heading="Blocks"
        ids={data.blocks}
        isTicketOnBoard={isTicketOnBoard}
        onOpenTicket={onOpenTicket}
      />
      <TicketModelsSection models={data.models} />
      <TicketSessionLinkSection
        sessionLinks={data.sessionLinks}
        pickerOpen={sessionLink.sessionLinkPickerOpen}
        onTogglePicker={sessionLink.togglePicker}
        isLoadingSessions={sessionLink.isLoadingSessions}
        activeSessionCandidates={sessionLink.activeSessionCandidates}
        mutationPending={sessionLink.sessionLinkMutationPending}
        mutationError={sessionLink.sessionLinkMutationError}
        onLinkSession={sessionLink.onLinkSession}
        onUnlinkSession={sessionLink.onUnlinkSession}
      />
      <TicketUsageSection usage={data.usage} />
      {pendingDecision !== undefined && attachmentsSection}
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
        expanded={timeline.timelineExpanded}
        onToggleExpanded={() =>
          timeline.setTimelineExpanded((expanded) => !expanded)
        }
        loading={timeline.timelineLoading}
        error={timeline.timelineError}
        events={timeline.timelineEvents}
      />
      {pendingDecision === undefined && attachmentsSection}
      <TicketCommentsSection
        enabled={comment.commentsEnabled}
        loading={comment.commentsLoading}
        error={comment.commentsError}
        comments={comment.comments}
        isTicketOnBoard={isTicketOnBoard}
        onOpenTicket={onOpenTicket}
        textareaRef={commentTextareaRef}
        commentText={comment.commentText}
        onCommentTextChange={comment.setCommentText}
        canSubmit={comment.canSubmitComment}
        mutation={comment.mutation}
      />
      <TicketQuickActionsSection
        priority={data.priority}
        confirmingQuickAction={quickActions.confirmingQuickAction}
        onSetConfirmingQuickAction={quickActions.setConfirmingQuickAction}
        quickActionsDisabled={quickActions.disabled}
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
        copyFeedback={copy.copyFeedback}
        onCopyNextStep={(target, nextStep) =>
          void copy.handleCopyNextStep(target, nextStep)
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
        copyFeedback={copy.copyFeedback}
        ariaLiveMessage={copy.ariaLiveMessage}
        onCopyCommand={(kind) => void copy.handleCopyCommand(kind)}
      />
    </>
  );
}
