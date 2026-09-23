import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TicketDetailDto } from '../../api';

// bdboard-sso1.5: TicketDetailSecondaryBody は TicketDetailBody の後半分の
// 配線コンポーネント。#654 opus レビュー指摘(スカラーだけのモックだと配線
// バグの大半を見逃す)を踏まえ、各 Section をモックし
// vi.mocked(X).mock.calls.at(-1)?.[0] で実際に渡された props をマーカー値
// ごと直接検証する。vitest.config は clearMocks/restoreMocks を有効にして
// いない(bdboard-cqur)ため、beforeEach で vi.clearAllMocks() する
// (AppBoardViewSwitch.test.tsx と同じパターン)。

vi.mock('./TicketIdListSection', () => ({
  TicketIdListSection: vi.fn(() => <div data-testid="id-list-section" />),
}));
vi.mock('./TicketDependenciesSection', () => ({
  TicketDependenciesSection: vi.fn(() => <div data-testid="dependencies-section" />),
}));
vi.mock('./TicketModelsSection', () => ({
  TicketModelsSection: vi.fn(() => <div data-testid="models-section" />),
}));
vi.mock('./TicketSessionLinkSection', () => ({
  TicketSessionLinkSection: vi.fn(() => <div data-testid="session-link-section" />),
}));
vi.mock('./TicketUsageSection', () => ({
  TicketUsageSection: vi.fn(() => <div data-testid="usage-section" />),
}));
vi.mock('./TicketDecisionSection', () => ({
  TicketDecisionSection: vi.fn(() => <div data-testid="decision-section" />),
}));
vi.mock('./TicketTimelineSection', () => ({
  TicketTimelineSection: vi.fn(() => <div data-testid="timeline-section" />),
}));
vi.mock('../TicketAttachments', () => ({
  TicketAttachments: vi.fn(() => <div data-testid="attachments-section" />),
}));
vi.mock('./TicketCommentsSection', () => ({
  TicketCommentsSection: vi.fn(() => <div data-testid="comments-section" />),
}));
vi.mock('./TicketQuickActionsSection', () => ({
  TicketQuickActionsSection: vi.fn(() => <div data-testid="quick-actions-section" />),
}));
vi.mock('./TicketAgentRunSection', () => ({
  TicketAgentRunSection: vi.fn(() => <div data-testid="agent-run-section" />),
}));
vi.mock('./TicketBdCommandSection', () => ({
  TicketBdCommandSection: vi.fn(() => <div data-testid="bd-command-section" />),
}));

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
import {
  TicketDetailSecondaryBody,
  type TicketDetailSecondaryBodyProps,
} from './TicketDetailSecondaryBody';

const idListMock = vi.mocked(TicketIdListSection);
const dependenciesMock = vi.mocked(TicketDependenciesSection);
const modelsMock = vi.mocked(TicketModelsSection);
const sessionLinkMock = vi.mocked(TicketSessionLinkSection);
const usageMock = vi.mocked(TicketUsageSection);
const decisionMock = vi.mocked(TicketDecisionSection);
const timelineMock = vi.mocked(TicketTimelineSection);
const attachmentsMock = vi.mocked(TicketAttachments);
const commentsMock = vi.mocked(TicketCommentsSection);
const quickActionsMock = vi.mocked(TicketQuickActionsSection);
const agentRunMock = vi.mocked(TicketAgentRunSection);
const bdCommandMock = vi.mocked(TicketBdCommandSection);

function makeData(overrides: Partial<TicketDetailDto> = {}): TicketDetailDto {
  return {
    id: 'MARK-id',
    projectId: 'MARK-project',
    title: 'MARK-title',
    status: 'MARK-status',
    priority: 3,
    issueType: 'MARK-issue-type',
    createdAt: 'MARK-created',
    updatedAt: 'MARK-updated',
    commentCount: 0,
    dependencies: [{ id: 'MARK-dep-1', title: 'dep', kind: 'blocks' }],
    blockedBy: ['MARK-blocked-by-1'],
    blocks: ['MARK-blocks-1'],
    sessionLinks: [{ sessionId: 'MARK-session-1', label: 'session' }],
    models: [{ name: 'MARK-model-1' }],
    children: [],
    ...overrides,
  } as TicketDetailDto;
}

function makeProps(
  overrides: Partial<TicketDetailSecondaryBodyProps> = {},
): TicketDetailSecondaryBodyProps {
  return {
    data: makeData(),
    ticketId: 'MARK-ticket-id',
    projectRootPath: 'MARK-project-root',
    pendingDecision: undefined,
    isTicketOnBoard: vi.fn(() => true),
    onOpenTicket: vi.fn(),
    dependencies: {
      // dependencyMutationPending/dependencySearchLoading は同じ Section 呼び出しに
      // 渡る同値 boolean(pigeonhole。opus レビュー2巡目 finding B)。素通しの配線
      // コンポーネントで実際に boolean 評価はされないので、文字列マーカーに
      // 差し替えて完全に区別する。
      dependencyMutationPending: 'MARK-dependency-mutation-pending' as unknown as boolean,
      handleRemoveDependency: vi.fn(),
      dependencySearchQuery: 'MARK-dep-query',
      setDependencySearchQuery: vi.fn(),
      hasDependencySearchQuery: true,
      dependencySearchLoading: 'MARK-dependency-search-loading' as unknown as boolean,
      dependencySearchError: 'MARK-dep-search-error',
      dependencyCandidates: [{ id: 'MARK-dep-candidate-1' }],
      handleAddDependency: vi.fn(),
      error: 'MARK-dep-error',
    } as unknown as TicketDetailSecondaryBodyProps['dependencies'],
    sessionLink: {
      // sessionLinkPickerOpen/isLoadingSessions も同値 boolean の衝突(finding B)。
      sessionLinkPickerOpen: 'MARK-session-link-picker-open' as unknown as boolean,
      togglePicker: vi.fn(),
      isLoadingSessions: 'MARK-is-loading-sessions' as unknown as boolean,
      activeSessionCandidates: [{ id: 'MARK-session-candidate-1' }],
      sessionLinkMutationPending: false,
      sessionLinkMutationError: 'MARK-session-link-error',
      onLinkSession: vi.fn(),
      onUnlinkSession: vi.fn(),
    } as unknown as TicketDetailSecondaryBodyProps['sessionLink'],
    decision: {
      selectedChoice: 'MARK-choice',
      setSelectedChoice: vi.fn(),
      freeformText: 'MARK-freeform',
      setFreeformText: vi.fn(),
      canSubmitDecision: true,
      decisionMutation: { mutate: vi.fn(), isPending: true, error: null },
      submittedDecision: { decisionId: 'MARK-decision-id' },
    } as unknown as TicketDetailSecondaryBodyProps['decision'],
    timeline: {
      timelineExpanded: true,
      setTimelineExpanded: vi.fn(),
      timelineLoading: false,
      timelineError: 'MARK-timeline-error',
      timelineEvents: [{ id: 'MARK-timeline-event-1' }],
    } as unknown as TicketDetailSecondaryBodyProps['timeline'],
    comment: {
      // commentsLoading/canSubmitComment も同値 boolean の衝突(finding B)。
      commentsEnabled: true,
      commentsLoading: 'MARK-comments-loading' as unknown as boolean,
      commentsError: 'MARK-comments-error',
      comments: [{ id: 'MARK-comment-1' }],
      commentText: 'MARK-comment-text',
      setCommentText: vi.fn(),
      canSubmitComment: 'MARK-can-submit-comment' as unknown as boolean,
      mutation: { mutate: vi.fn(), isPending: true, error: null },
    } as unknown as TicketDetailSecondaryBodyProps['comment'],
    quickActions: {
      confirmingQuickAction: { kind: 'claim' },
      setConfirmingQuickAction: vi.fn(),
      // disabled/deferSubmitDisabled/canRaisePriority/canLowerPriority/mutationPending
      // は同じ Section 呼び出しに渡る5つの boolean。2値では全部を pairwise で区別
      // できない(pigeonhole。finding B)ので文字列マーカーに差し替える。
      disabled: 'MARK-quick-actions-disabled' as unknown as boolean,
      deferPeriodKind: 'MARK-defer-kind',
      setDeferPeriodKind: vi.fn(),
      customDeferDate: 'MARK-defer-date',
      setCustomDeferDate: vi.fn(),
      deferSubmitDisabled: 'MARK-defer-submit-disabled' as unknown as boolean,
      handleDeferQuickAction: vi.fn(),
      canRaisePriority: 'MARK-can-raise-priority' as unknown as boolean,
      canLowerPriority: 'MARK-can-lower-priority' as unknown as boolean,
      // { current: null } 同士は toEqual で区別できない(finding A)。固有の current を
      // 入れる(モック越しなので実要素は不要)。
      quickActionConfirmRef: { current: 'MARK-quick-action-confirm-ref' },
      cancelQuickActionRef: { current: 'MARK-cancel-quick-action-ref' },
      handleCancelQuickAction: vi.fn(),
      closeReason: 'MARK-close-reason',
      setCloseReason: vi.fn(),
      mutationPending: 'MARK-quick-actions-mutation-pending' as unknown as boolean,
      handleConfirmQuickAction: vi.fn(),
      mutationError: 'MARK-quick-action-error',
    } as unknown as TicketDetailSecondaryBodyProps['quickActions'],
    agentRun: {
      polledRunDetail: { id: 'MARK-run-1' },
      activeRunMeta: { id: 'MARK-active-run' },
      // runStatusUnavailable/ticketRunsLoading も同値 boolean の衝突(finding B)。
      runStatusUnavailable: 'MARK-run-status-unavailable' as unknown as boolean,
      cancelRunMutation: { mutate: vi.fn(), isPending: true, error: null },
      ticketRunsLoading: true,
      ticketRunsError: 'MARK-ticket-runs-error',
      ticketRunsData: [{ id: 'MARK-ticket-run-1' }],
      selectedHistoryRunId: 'MARK-history-run-id',
      setSelectedHistoryRunId: vi.fn(),
      selectedHistoryRunLoading: false,
      selectedHistoryRunError: 'MARK-history-run-error',
      selectedHistoryRun: { id: 'MARK-history-run' },
    } as unknown as TicketDetailSecondaryBodyProps['agentRun'],
    copy: {
      copyFeedback: { kind: 'success', command: 'claim' },
      ariaLiveMessage: 'MARK-aria-live',
      handleCopyCommand: vi.fn(),
      handleCopyNextStep: vi.fn(),
    } as unknown as TicketDetailSecondaryBodyProps['copy'],
    commentTextareaRef: { current: null },
    ...overrides,
  };
}

describe('TicketDetailSecondaryBody', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('forwards dependencies/blocked-by/blocks/models/session-link/usage props with marker values', () => {
    const props = makeProps();
    render(<TicketDetailSecondaryBody {...props} />);

    expect(dependenciesMock.mock.calls.at(-1)?.[0]).toEqual({
      dependencies: props.data.dependencies,
      isTicketOnBoard: props.isTicketOnBoard,
      onOpenTicket: props.onOpenTicket,
      dependencyMutationPending: 'MARK-dependency-mutation-pending',
      onRemoveDependency: props.dependencies.handleRemoveDependency,
      dependencySearchQuery: 'MARK-dep-query',
      onDependencySearchQueryChange: props.dependencies.setDependencySearchQuery,
      hasDependencySearchQuery: true,
      dependencySearchLoading: 'MARK-dependency-search-loading',
      dependencySearchError: 'MARK-dep-search-error',
      dependencyCandidates: props.dependencies.dependencyCandidates,
      onAddDependency: props.dependencies.handleAddDependency,
      error: 'MARK-dep-error',
    });

    expect(idListMock.mock.calls[0]?.[0]).toEqual({
      heading: 'Blocked By',
      ids: props.data.blockedBy,
      isTicketOnBoard: props.isTicketOnBoard,
      onOpenTicket: props.onOpenTicket,
    });
    expect(idListMock.mock.calls[1]?.[0]).toEqual({
      heading: 'Blocks',
      ids: props.data.blocks,
      isTicketOnBoard: props.isTicketOnBoard,
      onOpenTicket: props.onOpenTicket,
    });

    expect(modelsMock.mock.calls.at(-1)?.[0]).toEqual({ models: props.data.models });

    expect(sessionLinkMock.mock.calls.at(-1)?.[0]).toEqual({
      sessionLinks: props.data.sessionLinks,
      pickerOpen: 'MARK-session-link-picker-open',
      onTogglePicker: props.sessionLink.togglePicker,
      isLoadingSessions: 'MARK-is-loading-sessions',
      activeSessionCandidates: props.sessionLink.activeSessionCandidates,
      mutationPending: false,
      mutationError: 'MARK-session-link-error',
      onLinkSession: props.sessionLink.onLinkSession,
      onUnlinkSession: props.sessionLink.onUnlinkSession,
    });

    expect(usageMock.mock.calls.at(-1)?.[0]).toEqual({ usage: props.data.usage });
  });

  it('forwards decision/timeline/attachments/comments props with marker values', () => {
    const props = makeProps();
    render(<TicketDetailSecondaryBody {...props} />);

    expect(decisionMock.mock.calls.at(-1)?.[0]).toEqual({
      pendingDecision: undefined,
      selectedChoice: 'MARK-choice',
      onSelectChoice: props.decision.setSelectedChoice,
      freeformText: 'MARK-freeform',
      onFreeformTextChange: props.decision.setFreeformText,
      canSubmitDecision: true,
      decisionMutation: props.decision.decisionMutation,
      submittedDecision: props.decision.submittedDecision,
      onOpenTicket: props.onOpenTicket,
    });

    expect(timelineMock.mock.calls.at(-1)?.[0]).toEqual({
      expanded: true,
      onToggleExpanded: expect.any(Function) as unknown,
      loading: false,
      error: 'MARK-timeline-error',
      events: props.timeline.timelineEvents,
    });
    const onToggleExpanded = timelineMock.mock.calls.at(-1)?.[0]
      .onToggleExpanded as () => void;
    onToggleExpanded();
    expect(props.timeline.setTimelineExpanded).toHaveBeenCalledTimes(1);
    const toggleFn = (props.timeline.setTimelineExpanded as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as (expanded: boolean) => boolean;
    expect(toggleFn(true)).toBe(false);

    expect(attachmentsMock.mock.calls.at(-1)?.[0]).toEqual({ ticketId: 'MARK-ticket-id' });

    expect(commentsMock.mock.calls.at(-1)?.[0]).toEqual({
      enabled: true,
      loading: 'MARK-comments-loading',
      error: 'MARK-comments-error',
      comments: props.comment.comments,
      isTicketOnBoard: props.isTicketOnBoard,
      onOpenTicket: props.onOpenTicket,
      textareaRef: props.commentTextareaRef,
      commentText: 'MARK-comment-text',
      onCommentTextChange: props.comment.setCommentText,
      canSubmit: 'MARK-can-submit-comment',
      mutation: props.comment.mutation,
    });
  });

  it('forwards quick-actions/agent-run/bd-command props with marker values, including copy-handler wiring', () => {
    const props = makeProps();
    render(<TicketDetailSecondaryBody {...props} />);

    expect(quickActionsMock.mock.calls.at(-1)?.[0]).toEqual({
      priority: 3,
      confirmingQuickAction: props.quickActions.confirmingQuickAction,
      onSetConfirmingQuickAction: props.quickActions.setConfirmingQuickAction,
      quickActionsDisabled: 'MARK-quick-actions-disabled',
      deferPeriodKind: 'MARK-defer-kind',
      onDeferPeriodKindChange: props.quickActions.setDeferPeriodKind,
      customDeferDate: 'MARK-defer-date',
      onCustomDeferDateChange: props.quickActions.setCustomDeferDate,
      deferSubmitDisabled: 'MARK-defer-submit-disabled',
      onDeferQuickAction: props.quickActions.handleDeferQuickAction,
      canRaisePriority: 'MARK-can-raise-priority',
      canLowerPriority: 'MARK-can-lower-priority',
      quickActionConfirmRef: props.quickActions.quickActionConfirmRef,
      cancelQuickActionRef: props.quickActions.cancelQuickActionRef,
      onCancelQuickAction: props.quickActions.handleCancelQuickAction,
      closeReason: 'MARK-close-reason',
      onCloseReasonChange: props.quickActions.setCloseReason,
      mutationPending: 'MARK-quick-actions-mutation-pending',
      onConfirmQuickAction: props.quickActions.handleConfirmQuickAction,
      mutationError: 'MARK-quick-action-error',
    });

    expect(agentRunMock.mock.calls.at(-1)?.[0]).toEqual({
      polledRunDetail: props.agentRun.polledRunDetail,
      activeRunMeta: props.agentRun.activeRunMeta,
      runStatusUnavailable: 'MARK-run-status-unavailable',
      copyFeedback: props.copy.copyFeedback,
      onCopyNextStep: expect.any(Function) as unknown,
      cancelRunMutation: props.agentRun.cancelRunMutation,
      ticketRunsLoading: true,
      ticketRunsError: 'MARK-ticket-runs-error',
      ticketRunsData: props.agentRun.ticketRunsData,
      selectedHistoryRunId: 'MARK-history-run-id',
      onSelectHistoryRun: props.agentRun.setSelectedHistoryRunId,
      selectedHistoryRunLoading: false,
      selectedHistoryRunError: 'MARK-history-run-error',
      selectedHistoryRun: props.agentRun.selectedHistoryRun,
    });
    const onCopyNextStep = agentRunMock.mock.calls.at(-1)?.[0]
      .onCopyNextStep as (target: string, nextStep: unknown) => void;
    onCopyNextStep('next-step-current', { command: 'MARK-next-step' });
    expect(props.copy.handleCopyNextStep).toHaveBeenCalledWith('next-step-current', {
      command: 'MARK-next-step',
    });

    expect(bdCommandMock.mock.calls.at(-1)?.[0]).toEqual({
      ticketId: 'MARK-id',
      projectRootPath: 'MARK-project-root',
      copyFeedback: props.copy.copyFeedback,
      ariaLiveMessage: 'MARK-aria-live',
      onCopyCommand: expect.any(Function) as unknown,
    });
    const onCopyCommand = bdCommandMock.mock.calls.at(-1)?.[0]
      .onCopyCommand as (kind: string) => void;
    onCopyCommand('claim');
    expect(props.copy.handleCopyCommand).toHaveBeenCalledWith('claim');
  });
});
