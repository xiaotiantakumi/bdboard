import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { BoardCardDto, BoardViewDto } from '../../api';
import { EMPTY_BOARD_FILTER } from '../../boardFilter';
import type { BoardFilterState } from '../../hooks/useBoardFilterState';
import type { NextUpRunLoopController } from '../next-up/run-loop/types';
import { AppBoardViewSwitch, type AppBoardViewSwitchProps } from './AppBoardViewSwitch';

// bdboard-62p4 PR-2: このファイルは AppBoardViewSwitch が持つ「view に応じた
// 出し分けロジック」と「props のルーティング(filterState/board/boardMeta →
// 各子コンポーネントの実際の prop)」を直接検証する。子コンポーネント自体の
// 描画内容は各自のテストで押さえられているため、ここではモックに置き換えて
// どの子がどの props で呼ばれるかだけを見る。

vi.mock('../BoardFilterBar', () => ({
  BoardFilterBar: vi.fn((props: { filterText: string }) => (
    <div data-testid="board-filter-bar">{props.filterText}</div>
  )),
}));
vi.mock('../BulkActionBar', () => ({
  BulkActionBar: vi.fn((props: { cardsById: Map<string, BoardCardDto> }) => (
    <div data-testid="bulk-action-bar">{props.cardsById.size}</div>
  )),
}));
vi.mock('../BoardView', () => ({
  BoardLanes: vi.fn((props: { sectionKey: string }) => (
    <div data-testid="board-lanes">{props.sectionKey}</div>
  )),
  SplitBoard: vi.fn(
    (props: {
      sectionKeyPrefix: string;
      onCardClick: (ticketId: string) => void;
      onSessionBadgeClick?: (projectId?: string) => void;
    }) => (
      <div data-testid="split-board">
        {props.sectionKeyPrefix}
        <button type="button" onClick={() => props.onCardClick('t-1')}>
          card
        </button>
        <button type="button" onClick={() => props.onSessionBadgeClick?.('proj-1')}>
          session
        </button>
      </div>
    ),
  ),
  hasVisibleCards: vi.fn(),
}));
vi.mock('../NextUpView', () => ({
  NextUpView: vi.fn((props: { limit: number }) => (
    <div data-testid="next-up-view">{props.limit}</div>
  )),
}));

import { hasVisibleCards } from '../BoardView';

const hasVisibleCardsMock = vi.mocked(hasVisibleCards);

function makeFilterState(overrides: Partial<BoardFilterState> = {}): BoardFilterState {
  return {
    priorityCeiling: 'all',
    setPriorityCeiling: vi.fn(),
    issueTypes: [],
    setIssueTypes: vi.fn(),
    labels: [],
    setLabels: vi.fn(),
    filterText: '',
    setFilterText: vi.fn(),
    hideDone: false,
    setHideDone: vi.fn(),
    stalledOnly: false,
    setStalledOnly: vi.fn(),
    collapsedLanes: [],
    collapsedLanesSet: new Set(),
    onToggleLaneCollapse: vi.fn(),
    filter: EMPTY_BOARD_FILTER,
    ...overrides,
  };
}

const stubBoardDto = { lanes: {}, cardCount: 0, closedTotal: 0, truncatedClosedIds: [] };

function makeBoardData(overrides: Partial<BoardViewDto> = {}): BoardViewDto {
  return {
    mode: 'merged',
    generatedAt: new Date().toISOString(),
    projects: [],
    merged: stubBoardDto,
    ...overrides,
  };
}

function makeProps(overrides: Partial<AppBoardViewSwitchProps> = {}): AppBoardViewSwitchProps {
  return {
    view: 'merged',
    filterState: makeFilterState(),
    epicFilterId: undefined,
    onClearEpicFilter: vi.fn(),
    board: {
      query: { data: undefined, isLoading: false, error: null },
      cardsById: new Map(),
      availableLabels: [],
    },
    boardMeta: {
      projectNames: new Map(),
      projectActiveSessions: new Map(),
      pendingDecisionIds: new Set(),
      prLinksById: new Map(),
      wipLimitsOverrides: {},
      selectedProjectIdsJoined: '',
    },
    onCardClick: vi.fn(),
    onSessionBadgeClick: vi.fn(),
    nextUp: {
      limit: 10,
      onLimitChange: vi.fn(),
      showEpics: false,
      onShowEpicsChange: vi.fn(),
      batchRun: {} as unknown as NextUpRunLoopController,
      harnessStatuses: undefined,
    },
    ...overrides,
  };
}

describe('AppBoardViewSwitch', () => {
  it('renders BoardFilterBar/BulkActionBar for merged view but not for next view', () => {
    hasVisibleCardsMock.mockReturnValue(true);
    const { rerender } = render(<AppBoardViewSwitch {...makeProps({ view: 'merged' })} />);
    expect(screen.getByTestId('board-filter-bar')).toBeInTheDocument();
    expect(screen.getByTestId('bulk-action-bar')).toBeInTheDocument();

    rerender(<AppBoardViewSwitch {...makeProps({ view: 'next' })} />);
    expect(screen.queryByTestId('board-filter-bar')).not.toBeInTheDocument();
    // Next Up も一括操作バーの対象 (bdboard-ml0k)
    expect(screen.getByTestId('bulk-action-bar')).toBeInTheDocument();
  });

  it('renders nothing for a non-board view (e.g. activity)', () => {
    const { container } = render(<AppBoardViewSwitch {...makeProps({ view: 'activity' })} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the loading and error states independently of board.query.data', () => {
    const { rerender } = render(
      <AppBoardViewSwitch
        {...makeProps({
          board: {
            query: { data: undefined, isLoading: true, error: null },
            cardsById: new Map(),
            availableLabels: [],
          },
        })}
      />,
    );
    expect(screen.getByText('読み込み中…')).toBeInTheDocument();

    rerender(
      <AppBoardViewSwitch
        {...makeProps({
          board: {
            query: { data: undefined, isLoading: false, error: new Error('boom') },
            cardsById: new Map(),
            availableLabels: [],
          },
        })}
      />,
    );
    expect(screen.getByText('boom')).toBeInTheDocument();
  });

  it('shows the epic filter indicator and calls onClearEpicFilter on click', async () => {
    const user = userEvent.setup();
    const onClearEpicFilter = vi.fn();
    render(
      <AppBoardViewSwitch {...makeProps({ epicFilterId: 'bdboard-abc', onClearEpicFilter })} />,
    );
    expect(screen.getByText('エピック bdboard-abc のみ表示中')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'クリア' }));
    expect(onClearEpicFilter).toHaveBeenCalledTimes(1);
  });

  it('shows an empty-state message instead of BoardLanes when hasVisibleCards is false and a filter is active', () => {
    hasVisibleCardsMock.mockReturnValue(false);
    render(
      <AppBoardViewSwitch
        {...makeProps({
          view: 'merged',
          filterState: makeFilterState({ filter: { ...EMPTY_BOARD_FILTER, text: 'foo' } }),
          board: {
            query: { data: makeBoardData(), isLoading: false, error: null },
            cardsById: new Map(),
            availableLabels: [],
          },
        })}
      />,
    );
    expect(screen.getByText('表示できるチケットがありません')).toBeInTheDocument();
    expect(screen.queryByTestId('board-lanes')).not.toBeInTheDocument();
  });

  it('renders BoardLanes with the merged-prefixed sectionKey when cards are visible', () => {
    hasVisibleCardsMock.mockReturnValue(true);
    render(
      <AppBoardViewSwitch
        {...makeProps({
          view: 'merged',
          board: {
            query: { data: makeBoardData(), isLoading: false, error: null },
            cardsById: new Map(),
            availableLabels: [],
          },
          boardMeta: {
            projectNames: new Map(),
            projectActiveSessions: new Map(),
            pendingDecisionIds: new Set(),
            prLinksById: new Map(),
            wipLimitsOverrides: {},
            selectedProjectIdsJoined: 'proj-1',
          },
        })}
      />,
    );
    expect(screen.getByTestId('board-lanes')).toHaveTextContent('merged-proj-1');
  });

  it('renders SplitBoard for the split view and forwards onCardClick/onSessionBadgeClick unchanged', async () => {
    const user = userEvent.setup();
    const onCardClick = vi.fn();
    const onSessionBadgeClick = vi.fn();
    render(
      <AppBoardViewSwitch
        {...makeProps({
          view: 'split',
          board: {
            query: { data: makeBoardData({ projects: [] }), isLoading: false, error: null },
            cardsById: new Map(),
            availableLabels: [],
          },
          boardMeta: {
            projectNames: new Map(),
            projectActiveSessions: new Map(),
            pendingDecisionIds: new Set(),
            prLinksById: new Map(),
            wipLimitsOverrides: {},
            selectedProjectIdsJoined: 'proj-2',
          },
          onCardClick,
          onSessionBadgeClick,
        })}
      />,
    );
    expect(screen.getByTestId('split-board')).toHaveTextContent('proj-2');
    await user.click(screen.getByRole('button', { name: 'card' }));
    expect(onCardClick).toHaveBeenCalledWith('t-1');
    await user.click(screen.getByRole('button', { name: 'session' }));
    expect(onSessionBadgeClick).toHaveBeenCalledWith('proj-1');
  });

  it('renders NextUpView with the nextUp.limit for the next view', () => {
    render(
      <AppBoardViewSwitch
        {...makeProps({
          view: 'next',
          board: {
            query: { data: makeBoardData(), isLoading: false, error: null },
            cardsById: new Map(),
            availableLabels: [],
          },
          nextUp: {
            limit: 20,
            onLimitChange: vi.fn(),
            showEpics: true,
            onShowEpicsChange: vi.fn(),
            batchRun: {} as unknown as NextUpRunLoopController,
            harnessStatuses: undefined,
          },
        })}
      />,
    );
    expect(screen.getByTestId('next-up-view')).toHaveTextContent('20');
  });

  it('shows the "no merged data" message when merged is null for merged/next but not for other board views', () => {
    const { rerender } = render(
      <AppBoardViewSwitch
        {...makeProps({
          view: 'merged',
          board: {
            query: { data: makeBoardData({ merged: null }), isLoading: false, error: null },
            cardsById: new Map(),
            availableLabels: [],
          },
        })}
      />,
    );
    expect(screen.getByText('統合ビューのデータがありません')).toBeInTheDocument();

    rerender(
      <AppBoardViewSwitch
        {...makeProps({
          view: 'split',
          board: {
            query: { data: makeBoardData({ merged: null, projects: [] }), isLoading: false, error: null },
            cardsById: new Map(),
            availableLabels: [],
          },
        })}
      />,
    );
    expect(screen.queryByText('統合ビューのデータがありません')).not.toBeInTheDocument();
  });
});
