import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TicketDetailDto } from '../../api';

// bdboard-sso1.5: TicketDetailBody は「controller が返すグループ化済みオブジェクトを
// 各 Section コンポーネントの個別 props へ変換して渡すだけ」の配線コンポーネント。
// #654 の opus レビュー指摘(スカラー1つだけ描くモックだと配線バグの大半を見逃す)を
// 踏まえ、各 Section をモックし vi.mocked(X).mock.calls.at(-1)?.[0] で実際に渡された
// props をマーカー値ごと深く検証する。
//
// このPR自身のレビュー(opus)で「同じ呼び出し内の複数の boolean がすべて true だと
// 取り違え(例: agentRunActionsDisabled に hasActiveRun を渡す誤配線)を検出できない」
// 「空配列同士は toEqual では区別が付かない」という2つの見逃しパターンを指摘された。
// 対策として: (1) 同じ Section 呼び出しに渡る boolean は互いに異なる値にする、
// (2) 空配列ではなく要素内容で識別できる配列を使う。
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
    notes: 'MARK-notes-body-text',
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
      // trigger に同時に渡る2つの boolean (agentRunActionsDisabled/hasActiveRun) は
      // 取り違えを検出できるよう異なる値にする。
      actionsDisabled: true,
      runStartDisabled: { disabled: true, reason: 'MARK-run-block' },
      harnessRunBlockReason: 'MARK-harness-block',
      hasActiveRun: false,
      // confirm に同時に渡る2つの boolean (confirmingAgentRun/startRunPending) も同様。
      confirmingAgentRun: true,
      setConfirmingAgentRun: vi.fn(),
      agentRunConfirmRef: { current: null },
      cancelAgentRunConfirmRef: { current: null },
      handleCancelAgentRun: vi.fn(),
      startRunMutation: { mutate: vi.fn(), isPending: false, error: null },
    } as unknown as TicketDetailBodyProps['agentRun'],
    labels: {
      currentLabels: ['MARK-label-1'],
      labelInputQuery: 'MARK-label-query',
      setLabelInputQuery: vi.fn(),
      trimmedLabelInput: 'MARK-trimmed',
      labelSuggestions: ['MARK-suggestion'],
      // canSubmitLabel/labelMutationPending/isAddPending は同じ Section 呼び出しに
      // 同時に渡るので、少なくとも隣接ペアが異なる値になるようにする
      // (isAddPending <- labelMutationPending の取り違えを検出するのが目的)。
      canSubmitLabel: false,
      labelMutationPending: true,
      isAddPending: false,
      error: 'MARK-label-error',
      handleAddLabel: vi.fn(),
      handleRemoveLabel: vi.fn(),
    } as unknown as TicketDetailBodyProps['labels'],
    inFlightOverlaps: {
      inFlightOverlapsEnabled: true,
      inFlightOverlapsError: 'MARK-overlap-error',
      inFlightOverlaps: [{ MARK: 'overlap-1' }],
    } as unknown as TicketDetailBodyProps['inFlightOverlaps'],
    similarTickets: {
      similarTicketsLoading: true,
      similarTicketsError: 'MARK-similar-error',
      similarTickets: [{ MARK: 'similar-1' }],
    } as unknown as TicketDetailBodyProps['similarTickets'],
    description: {
      descriptionEditing: true,
      descriptionDraft: 'MARK-desc-draft',
      setDescriptionDraft: vi.fn(),
      canSaveDescription: false,
      isSaving: false,
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
      hasActiveRun: false,
      onStartConfirm: expect.any(Function) as unknown,
    });

    expect(confirmMock.mock.calls.at(-1)?.[0]).toEqual({
      ticketId: 'MARK-ticket-id',
      confirmingAgentRun: true,
      agentRunConfirmRef: props.agentRun.agentRunConfirmRef,
      cancelAgentRunConfirmRef: props.agentRun.cancelAgentRunConfirmRef,
      onCancelAgentRun: props.agentRun.handleCancelAgentRun,
      onStartRun: expect.any(Function) as unknown,
      startRunPending: false,
      startRunError: null,
    });
  });

  it('forwards labels/in-flight-overlaps/similar-tickets/description with marker values, including non-empty arrays', () => {
    const props = makeProps();
    render(<TicketDetailBody {...props} />);

    expect(labelsMock.mock.calls.at(-1)?.[0]).toEqual({
      currentLabels: ['MARK-label-1'],
      labelInputQuery: 'MARK-label-query',
      onLabelInputQueryChange: props.labels.setLabelInputQuery,
      trimmedLabelInput: 'MARK-trimmed',
      labelSuggestions: ['MARK-suggestion'],
      canSubmitLabel: false,
      labelMutationPending: true,
      isAddPending: false,
      error: 'MARK-label-error',
      onAddLabel: props.labels.handleAddLabel,
      onRemoveLabel: props.labels.handleRemoveLabel,
    });

    expect(inFlightMock.mock.calls.at(-1)?.[0]).toEqual({
      enabled: true,
      error: 'MARK-overlap-error',
      overlaps: [{ MARK: 'overlap-1' }],
      isTicketOnBoard: props.isTicketOnBoard,
      onOpenTicket: props.onOpenTicket,
    });

    expect(similarMock.mock.calls.at(-1)?.[0]).toEqual({
      loading: true,
      error: 'MARK-similar-error',
      tickets: [{ MARK: 'similar-1' }],
      isTicketOnBoard: props.isTicketOnBoard,
      onOpenTicket: props.onOpenTicket,
    });

    expect(descriptionMock.mock.calls.at(-1)?.[0]).toEqual({
      description: 'MARK-description',
      descriptionEditing: true,
      descriptionDraft: 'MARK-desc-draft',
      onDescriptionDraftChange: props.description.setDescriptionDraft,
      canSaveDescription: false,
      isSaving: false,
      error: 'MARK-desc-error',
      onStartDescriptionEdit: props.description.handleStartDescriptionEdit,
      onCancelDescriptionEdit: props.description.handleCancelDescriptionEdit,
      onSaveDescription: props.description.handleSaveDescription,
      isTicketOnBoard: props.isTicketOnBoard,
      onOpenTicket: props.onOpenTicket,
    });
  });

  it('forwards children props and wires onFilterByEpic to call through with data.id', () => {
    const props = makeProps();
    render(<TicketDetailBody {...props} />);

    expect(childrenMock.mock.calls.at(-1)?.[0]).toEqual({
      children: props.data.children,
      isTicketOnBoard: props.isTicketOnBoard,
      onOpenTicket: props.onOpenTicket,
      onFilterByEpic: expect.any(Function) as unknown,
    });

    // onFilterByEpic は data.id を閉じ込めたラッパー関数として渡る。呼び出すと
    // 実際に props.onFilterByEpic('MARK-id') が呼ばれることまで確認する
    // (ラッパーが別のIDや別のハンドラを閉じ込めていないか)。
    const onFilterByEpicWrapper = childrenMock.mock.calls.at(-1)?.[0]
      .onFilterByEpic as () => void;
    onFilterByEpicWrapper();
    expect(props.onFilterByEpic).toHaveBeenCalledWith('MARK-id');
  });

  it('renders every DetailField row (ID/Status/Priority/IssueType/PR/Assignee/Owner/Created/Updated/Started/Closed/DeferUntil) and the Notes body from data', () => {
    const props = makeProps();
    const { getByText, container } = render(<TicketDetailBody {...props} />);

    expect(getByText('MARK-id')).toBeInTheDocument();
    expect(getByText('MARK-status')).toBeInTheDocument();
    expect(getByText('P2')).toBeInTheDocument();
    expect(getByText('MARK-issue-type')).toBeInTheDocument();
    expect(getByText('MARK-assignee')).toBeInTheDocument();
    expect(getByText('MARK-owner')).toBeInTheDocument();
    // formatDateTime はパース不能な文字列をそのまま返すので、各フィールドが
    // 正しい元データにひも付いていることを個別の値で確認できる
    // (Created が誤って updatedAt を表示している、等の入れ替わりを検出する)。
    expect(getByText('MARK-created')).toBeInTheDocument();
    expect(getByText('MARK-updated')).toBeInTheDocument();
    expect(getByText('MARK-started')).toBeInTheDocument();
    expect(getByText('MARK-closed')).toBeInTheDocument();
    expect(getByText('MARK-defer')).toBeInTheDocument();
    // PR バッジ (state: 'open' -> "PR open" というラベルで描画される)。
    expect(getByText('PR open')).toBeInTheDocument();
    expect(getByText('Notes')).toBeInTheDocument();
    // MarkdownContent はハイフン区切りの語を bead リンクとして解釈し、Notes 本文を
    // 複数のノードに分割し得るため(例: "MARK-notes" と "body-text" が別ボタンになる)、
    // getByText で単一ノード一致を求めず、Notes セクション全体の textContent へ
    // 連結後の文字列で判定する(data.notes に正しくひも付いていることの確認が目的)。
    const notesSection = getByText('Notes').closest('.detail-section');
    expect(notesSection?.textContent).toContain('MARK-notes-body-text');

    const labels = Array.from(container.querySelectorAll('.detail-field-label')).map(
      (el) => el.textContent,
    );
    expect(labels).toEqual([
      'ID',
      'Status',
      'Priority',
      'Issue Type',
      'PR',
      'Assignee',
      'Owner',
      'Parent ID',
      'Created',
      'Updated',
      'Started',
      'Closed',
      'Defer Until',
    ]);
  });

  it('hides the chat button and omits assignee/owner/PR/dates when absent from data/props', () => {
    const props = makeProps({
      onChatAboutTicket: undefined,
      prLink: undefined,
      data: makeData({
        assignee: undefined,
        owner: undefined,
        parentId: undefined,
        startedAt: undefined,
        closedAt: undefined,
        deferUntil: undefined,
        notes: undefined,
      }),
    });
    const { queryByText, container } = render(<TicketDetailBody {...props} />);

    expect(queryByText('このチケットについてチャット')).not.toBeInTheDocument();
    expect(queryByText('MARK-assignee')).not.toBeInTheDocument();
    expect(queryByText('MARK-owner')).not.toBeInTheDocument();
    expect(queryByText('PR open')).not.toBeInTheDocument();
    expect(queryByText('MARK-started')).not.toBeInTheDocument();
    expect(queryByText('MARK-closed')).not.toBeInTheDocument();
    expect(queryByText('MARK-defer')).not.toBeInTheDocument();
    expect(queryByText('Notes')).not.toBeInTheDocument();

    const labels = Array.from(container.querySelectorAll('.detail-field-label')).map(
      (el) => el.textContent,
    );
    expect(labels).toEqual(['ID', 'Status', 'Priority', 'Issue Type', 'Created', 'Updated']);
  });
});
