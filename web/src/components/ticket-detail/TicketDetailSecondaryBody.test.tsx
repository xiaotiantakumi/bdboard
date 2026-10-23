import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TicketDetailDto } from '../../api';
import type { PendingDecisionDto } from '../../api';

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

import { TicketIdListSection } from './TicketIdListSection';
import { TicketDependenciesSection } from './TicketDependenciesSection';
import { TicketModelsSection } from './TicketModelsSection';
import { TicketUsageSection } from './TicketUsageSection';
import { TicketDecisionSection } from './TicketDecisionSection';
import { TicketTimelineSection } from './TicketTimelineSection';
import { TicketAttachments } from '../TicketAttachments';
import { TicketCommentsSection } from './TicketCommentsSection';
import {
  TicketDetailSecondaryBody,
  type TicketDetailSecondaryBodyProps,
} from './TicketDetailSecondaryBody';

const idListMock = vi.mocked(TicketIdListSection);
const dependenciesMock = vi.mocked(TicketDependenciesSection);
const modelsMock = vi.mocked(TicketModelsSection);
const usageMock = vi.mocked(TicketUsageSection);
const decisionMock = vi.mocked(TicketDecisionSection);
const timelineMock = vi.mocked(TicketTimelineSection);
const attachmentsMock = vi.mocked(TicketAttachments);
const commentsMock = vi.mocked(TicketCommentsSection);

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

  describe('attachment section order', () => {
    function sectionIndexes(container: HTMLElement): Map<string, number> {
      return new Map(
        [...container.querySelectorAll<HTMLElement>('[data-testid]')].map(
          (element, index) => [element.dataset.testid ?? '', index],
        ),
      );
    }

    it('keeps attachments between timeline and comments when no decision is pending', () => {
      const props = makeProps();
      const { container } = render(<TicketDetailSecondaryBody {...props} />);
      const indexes = sectionIndexes(container);

      expect(indexes.get('attachments-section')).toBeGreaterThan(
        indexes.get('timeline-section') ?? -1,
      );
      expect(indexes.get('attachments-section')).toBeLessThan(
        indexes.get('comments-section') ?? -1,
      );
      expect(indexes.get('decision-section')).toBeGreaterThan(
        indexes.get('comments-section') ?? -1,
      );
      expect(attachmentsMock).toHaveBeenCalledTimes(1);
      expect(attachmentsMock.mock.calls[0]?.[0]).toEqual({
        ticketId: 'MARK-ticket-id',
      });
    });

    it('places attachments between usage and decision while a decision is pending', () => {
      const pendingDecision: PendingDecisionDto = {
        id: 'MARK-pending-id',
        kind: 'ticket',
        projectId: 'MARK-project',
        allowFreeform: true,
      };
      const props = makeProps({ pendingDecision });
      const { container } = render(<TicketDetailSecondaryBody {...props} />);
      const indexes = sectionIndexes(container);

      expect(indexes.get('attachments-section')).toBeGreaterThan(
        indexes.get('usage-section') ?? -1,
      );
      expect(indexes.get('attachments-section')).toBeLessThan(
        indexes.get('decision-section') ?? -1,
      );
      expect(indexes.get('attachments-section')).toBeLessThan(
        indexes.get('timeline-section') ?? -1,
      );
      expect(attachmentsMock).toHaveBeenCalledTimes(1);
      expect(attachmentsMock.mock.calls[0]?.[0]).toEqual({
        ticketId: 'MARK-ticket-id',
      });
    });

    // bdboard-u6hf レビュー指摘: pendingDecision が解消された(または新たに付いた)
    // ときに、添付画像セクションが重複表示/消失せず、正しい新しい位置に1つだけ
    // 移動することを rerender で確認する(移動時に remount されないための
    // key="attachments" の付与自体は、この DOM 上のアサーションでは直接検証できない
    // が、少なくとも二重描画や消失が無いことは担保する)。
    it('moves attachments to the new position when pendingDecision changes on rerender', () => {
      const pendingDecision: PendingDecisionDto = {
        id: 'MARK-pending-id',
        kind: 'ticket',
        projectId: 'MARK-project',
        allowFreeform: true,
      };
      const pendingProps = makeProps({ pendingDecision });
      const { container, rerender } = render(
        <TicketDetailSecondaryBody {...pendingProps} />,
      );

      let indexes = sectionIndexes(container);
      expect(indexes.get('attachments-section')).toBeLessThan(
        indexes.get('decision-section') ?? -1,
      );
      expect(
        container.querySelectorAll('[data-testid="attachments-section"]'),
      ).toHaveLength(1);

      const resolvedProps = makeProps({ pendingDecision: undefined });
      rerender(<TicketDetailSecondaryBody {...resolvedProps} />);

      indexes = sectionIndexes(container);
      expect(indexes.get('decision-section')).toBeGreaterThan(
        indexes.get('comments-section') ?? -1,
      );
      expect(indexes.get('attachments-section')).toBeLessThan(
        indexes.get('comments-section') ?? -1,
      );
      expect(
        container.querySelectorAll('[data-testid="attachments-section"]'),
      ).toHaveLength(1);
    });
  });
});
