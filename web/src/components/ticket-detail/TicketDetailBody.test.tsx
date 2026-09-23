import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TicketDetailDto } from '../../api';

// bdboard-sso1.5: TicketDetailBody は「controller が返すグループ化済みオブジェクトを
// 各 Section コンポーネントの個別 props へ変換して渡すだけ」の配線コンポーネント。
// #654 の opus レビュー指摘(スカラー1つだけ描くモックだと配線バグの大半を見逃す)を
// 踏まえ、各 Section をモックし vi.mocked(X).mock.calls.at(-1)?.[0] で実際に渡された
// props をマーカー値ごと深く検証する。

vi.mock('./TicketAgentRunTriggerSection', () => ({
  TicketAgentRunTrigger: vi.fn(() => <div data-testid="agent-run-trigger" />),
  TicketAgentRunConfirm: vi.fn(() => <div data-testid="agent-run-confirm" />),
}));
vi.mock('./TicketChildrenSection', () => ({
  TicketChildrenSection: vi.fn(() => <div data-testid="children-section" />),
}));
vi.mock('./TicketInFlightOverlapsSection', () => ({
  TicketInFlightOverlapsSection: vi.fn(() => <div data-testid="in-flight-section" />),
}));
vi.mock('./TicketSimilarTicketsSection', () => ({
  TicketSimilarTicketsSection: vi.fn(() => <div data-testid="similar-section" />),
}));
vi.mock('./TicketLabelsSection', () => ({
  TicketLabelsSection: vi.fn(() => <div data-testid="labels-section" />),
}));
vi.mock('./TicketDescriptionSection', () => ({
  TicketDescriptionSection: vi.fn(() => <div data-testid="description-section" />),
}));

import { TicketAgentRunTrigger, TicketAgentRunConfirm } from './TicketAgentRunTriggerSection';
import { TicketChildrenSection } from './TicketChildrenSection';
import { TicketInFlightOverlapsSection } from './TicketInFlightOverlapsSection';
import { TicketSimilarTicketsSection } from './TicketSimilarTicketsSection';
import { TicketLabelsSection } from './TicketLabelsSection';
import { TicketDescriptionSection } from './TicketDescriptionSection';
import { TicketDetailBody, type TicketDetailBodyProps } from './TicketDetailBody';

const triggerMock = vi.mocked(TicketAgentRunTrigger);
const confirmMock = vi.mocked(TicketAgentRunConfirm);
const childrenMock = vi.mocked(TicketChildrenSection);
const inFlightMock = vi.mocked(TicketInFlightOverlapsSection);
const similarMock = vi.mocked(TicketSimilarTicketsSection);
const labelsMock = vi.mocked(TicketLabelsSection);
const descriptionMock = vi.mocked(TicketDescriptionSection);

function makeData(overrides: Partial<TicketDetailDto> = {}): TicketDetailDto {
  return {
    id: 'MARK-id',
    projectId: 'MARK-project',
    title: 'MARK-title',
    status: 'MARK-status',
    priority: 2,
    issueType: 'MARK-issue-type',
    createdAt: 'MARK-created',
    updatedAt: 'MARK-updated',
    startedAt: 'MARK-started',
    closedAt: 'MARK-closed',
    deferUntil: 'MARK-defer',
    assignee: 'MARK-assignee',
    owner: 'MARK-owner',
    parentId: 'MARK-parent',
    commentCount: 7,
    description: 'MARK-description',
    notes: 'MARK-notes',
    dependencies: [],
    blockedBy: [],
    blocks: [],
    usage: undefined,
    sessionLinks: [],
    models: [],
    children: [{ id: 'MARK-child-1', title: 'child', lane: 'ready' }],
    ...overrides,
  };
}

function makeProps(overrides: Partial<TicketDetailBodyProps> = {}): TicketDetailBodyProps {
  return {
    data: makeData(),
    ticketId: 'MARK-ticket-id',
    prLink: {
      ticketId: 'MARK-ticket-id',
      projectId: 'MARK-project',
      url: 'https://example.test/pr/1',
      state: 'open',
      checkStatus: 'success',
    },
    onChatAboutTicket: vi.fn(),
    isTicketOnBoard: vi.fn(() => true),
    onOpenTicket: vi.fn(),
    onFilterByEpic: vi.fn(),
    agentRun: {
      actionsDisabled: true,
      runStartDisabled: { disabled: true, reason: 'MARK-run-block' },
      harnessRunBlockReason: 'MARK-harness-block',
      hasActiveRun: true,
      confirmingAgentRun: true,
      setConfirmingAgentRun: vi.fn(),
      agentRunConfirmRef: { current: null },
      cancelAgentRunConfirmRef: { current: null },
      handleCancelAgentRun: vi.fn(),
      startRunMutation: { mutate: vi.fn(), isPending: true, error: null },
    } as unknown as TicketDetailBodyProps['agentRun'],
    labels: {
      currentLabels: ['MARK-label-1'],
      labelInputQuery: 'MARK-label-query',
      setLabelInputQuery: vi.fn(),
      trimmedLabelInput: 'MARK-trimmed',
      labelSuggestions: ['MARK-suggestion'],
      canSubmitLabel: true,
      labelMutationPending: true,
      isAddPending: true,
      error: 'MARK-label-error',
      handleAddLabel: vi.fn(),
      handleRemoveLabel: vi.fn(),
    } as unknown as TicketDetailBodyProps['labels'],
    inFlightOverlaps: {
      inFlightOverlapsEnabled: true,
      inFlightOverlapsError: 'MARK-overlap-error',
      inFlightOverlaps: [],
    } as unknown as TicketDetailBodyProps['inFlightOverlaps'],
    similarTickets: {
      similarTicketsLoading: true,
      similarTicketsError: 'MARK-similar-error',
      similarTickets: [],
    } as unknown as TicketDetailBodyProps['similarTickets'],
    description: {
      descriptionEditing: true,
      descriptionDraft: 'MARK-desc-draft',
      setDescriptionDraft: vi.fn(),
      canSaveDescription: true,
      isSaving: true,
      error: 'MARK-desc-error',
      handleStartDescriptionEdit: vi.fn(),
      handleCancelDescriptionEdit: vi.fn(),
      handleSaveDescription: vi.fn(),
    } as unknown as TicketDetailBodyProps['description'],
    ...overrides,
  };
}

describe('TicketDetailBody', () => {
  // vitest.config は clearMocks/restoreMocks を有効にしていない(bdboard-cqur)ため、
  // mock.calls の履歴はテスト間で蓄積する。呼び出し履歴だけをクリアする
  // (AppBoardViewSwitch.test.tsx と同じパターン)。
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('forwards agentRun trigger/confirm props with distinct marker values', () => {
    const props = makeProps();
    render(<TicketDetailBody {...props} />);

    expect(triggerMock.mock.calls.at(-1)?.[0]).toEqual({
      agentRunActionsDisabled: true,
      runStartDisabled: props.agentRun.runStartDisabled,
      harnessRunBlockReason: 'MARK-harness-block',
      hasActiveRun: true,
      onStartConfirm: expect.any(Function) as unknown,
    });

    expect(confirmMock.mock.calls.at(-1)?.[0]).toEqual({
      ticketId: 'MARK-ticket-id',
      confirmingAgentRun: true,
      agentRunConfirmRef: props.agentRun.agentRunConfirmRef,
      cancelAgentRunConfirmRef: props.agentRun.cancelAgentRunConfirmRef,
      onCancelAgentRun: props.agentRun.handleCancelAgentRun,
      onStartRun: expect.any(Function) as unknown,
      startRunPending: true,
      startRunError: null,
    });
  });

  it('forwards labels/children/in-flight-overlaps/similar-tickets/description with marker values', () => {
    const props = makeProps();
    render(<TicketDetailBody {...props} />);

    expect(labelsMock.mock.calls.at(-1)?.[0]).toEqual({
      currentLabels: ['MARK-label-1'],
      labelInputQuery: 'MARK-label-query',
      onLabelInputQueryChange: props.labels.setLabelInputQuery,
      trimmedLabelInput: 'MARK-trimmed',
      labelSuggestions: ['MARK-suggestion'],
      canSubmitLabel: true,
      labelMutationPending: true,
      isAddPending: true,
      error: 'MARK-label-error',
      onAddLabel: props.labels.handleAddLabel,
      onRemoveLabel: props.labels.handleRemoveLabel,
    });

    expect(childrenMock.mock.calls.at(-1)?.[0]).toMatchObject({
      children: props.data.children,
      isTicketOnBoard: props.isTicketOnBoard,
      onOpenTicket: props.onOpenTicket,
      onFilterByEpic: expect.any(Function) as unknown,
    });

    expect(inFlightMock.mock.calls.at(-1)?.[0]).toEqual({
      enabled: true,
      error: 'MARK-overlap-error',
      overlaps: [],
      isTicketOnBoard: props.isTicketOnBoard,
      onOpenTicket: props.onOpenTicket,
    });

    expect(similarMock.mock.calls.at(-1)?.[0]).toEqual({
      loading: true,
      error: 'MARK-similar-error',
      tickets: [],
      isTicketOnBoard: props.isTicketOnBoard,
      onOpenTicket: props.onOpenTicket,
    });

    expect(descriptionMock.mock.calls.at(-1)?.[0]).toEqual({
      description: 'MARK-description',
      descriptionEditing: true,
      descriptionDraft: 'MARK-desc-draft',
      onDescriptionDraftChange: props.description.setDescriptionDraft,
      canSaveDescription: true,
      isSaving: true,
      error: 'MARK-desc-error',
      onStartDescriptionEdit: props.description.handleStartDescriptionEdit,
      onCancelDescriptionEdit: props.description.handleCancelDescriptionEdit,
      onSaveDescription: props.description.handleSaveDescription,
      isTicketOnBoard: props.isTicketOnBoard,
      onOpenTicket: props.onOpenTicket,
    });
  });

  it('renders the DetailField rows and Notes block from data, and hides the chat button when onChatAboutTicket is absent', () => {
    const props = makeProps({ onChatAboutTicket: undefined });
    const { getByText, queryByText, container } = render(<TicketDetailBody {...props} />);

    expect(getByText('MARK-id')).toBeInTheDocument();
    expect(getByText('MARK-status')).toBeInTheDocument();
    expect(getByText('P2')).toBeInTheDocument();
    expect(getByText('MARK-issue-type')).toBeInTheDocument();
    expect(getByText('MARK-assignee')).toBeInTheDocument();
    expect(getByText('MARK-owner')).toBeInTheDocument();
    expect(getByText('Notes')).toBeInTheDocument();
    expect(queryByText('このチケットについてチャット')).not.toBeInTheDocument();
    expect(container.querySelectorAll('.detail-field').length).toBeGreaterThan(0);
  });
});
