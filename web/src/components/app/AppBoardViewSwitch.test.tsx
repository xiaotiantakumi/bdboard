import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoardCardDto, BoardViewDto, PrBadgeDto, ProjectHarnessStatusDto } from '../../api';
import { EMPTY_BOARD_FILTER } from '../../boardFilter';
import type { BoardFilterState } from '../../hooks/useBoardFilterState';
import type { NextUpRunLoopController } from '../nextUpRunLoop';
import { AppBoardViewSwitch, type AppBoardViewSwitchProps } from './AppBoardViewSwitch';

// bdboard-62p4 PR-2: このファイルは AppBoardViewSwitch が持つ「view に応じた
// 出し分けロジック」と「props のルーティング(filterState/board/boardMeta →
// 各子コンポーネントの実際の prop)」を直接検証する。子コンポーネント自体の
// 描画内容は各自のテストで押さえられているため、ここではモックに置き換えて
// どの子がどの props で呼ばれるかだけを見る。
//
// opus レビュー(PR#654)指摘: 当初のバージョンは各モックが1つのスカラー値
// だけを画面に出す形で、pendingDecisionIds/prLinksById/wipLimitsOverrides/
// collapsedLanes/onToggleLaneCollapse/harnessStatuses 等が空値へ差し替え
// られても検知できなかった(20件中12件の変異が素通り)。以降のテストは
// 可能な限り `vi.mocked(X).mock.calls.at(-1)?.[0]` で実際に渡された props
// オブジェクト全体を検証し、区別可能なマーカー値(固有の Map/Set/オブジェクト)
// を使うことで「空値/デフォルト値にすり替わっていないか」まで見る。

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

import { BoardFilterBar } from '../BoardFilterBar';
import { BulkActionBar } from '../BulkActionBar';
import { hasVisibleCards, SplitBoard } from '../BoardView';
import { NextUpView } from '../NextUpView';

const hasVisibleCardsMock = vi.mocked(hasVisibleCards);
const splitBoardMock = vi.mocked(SplitBoard);
const nextUpViewMock = vi.mocked(NextUpView);
const bulkActionBarMock = vi.mocked(BulkActionBar);
const boardFilterBarMock = vi.mocked(BoardFilterBar);

// beforeEach で毎回クリアする: vitest.config は clearMocks/restoreMocks を
// 有効にしていないため、素の状態だと hasVisibleCardsMock.mockReturnValue(...)
// が後続テストへ漏れて実行順依存になる(opus レビュー指摘)。vi.clearAllMocks()
// は呼び出し履歴だけを消し、vi.fn(impl) の実装は残すので描画は壊れない。
beforeEach(() => {
  vi.clearAllMocks();
  hasVisibleCardsMock.mockReturnValue(true);
});

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
    view: 'split',
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
  it('renders BoardFilterBar/BulkActionBar for split view but not for next view', () => {
    const { rerender } = render(<AppBoardViewSwitch {...makeProps({ view: 'split' })} />);
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

  it('hides the loading state, epic-filter indicator, and filter/bulk bars for a non-board view, even when their trigger conditions are true', () => {
    // opus レビュー指摘の変異「読み込み中表示が全ビューに出る」「エピック
    // バナーが全ビューに出る」を直接検知するテスト。view が非ボード系なら
    // isLoading/epicFilterId が真でも何も出してはいけない。
    const { container } = render(
      <AppBoardViewSwitch
        {...makeProps({
          view: 'activity',
          epicFilterId: 'bdboard-should-not-show',
          board: {
            query: { data: undefined, isLoading: true, error: null },
            cardsById: new Map([['t-1', {} as BoardCardDto]]),
            availableLabels: ['should-not-reach-bulk-bar'],
          },
        })}
      />,
    );
    expect(container).toBeEmptyDOMElement();
    expect(boardFilterBarMock).not.toHaveBeenCalled();
    expect(bulkActionBarMock).not.toHaveBeenCalled();
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

  it('falls back to the generic error message when the error is not an Error instance', () => {
    render(
      <AppBoardViewSwitch
        {...makeProps({
          board: {
            query: {
              data: undefined,
              isLoading: false,
              error: 'not-an-error-instance' as unknown as Error,
            },
            cardsById: new Map(),
            availableLabels: [],
          },
        })}
      />,
    );
    expect(screen.getByText('ボードの読み込みに失敗しました')).toBeInTheDocument();
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

  it('renders SplitBoard when a filter is active', () => {
    render(
      <AppBoardViewSwitch
        {...makeProps({
          view: 'split',
          filterState: makeFilterState({ filter: { ...EMPTY_BOARD_FILTER, text: 'foo' } }),
          board: {
            query: { data: makeBoardData(), isLoading: false, error: null },
            cardsById: new Map(),
            availableLabels: [],
          },
        })}
      />,
    );
    expect(screen.getByTestId('split-board')).toBeInTheDocument();
  });

  it('renders SplitBoard when stalled-only is active', () => {
    render(
      <AppBoardViewSwitch
        {...makeProps({
          view: 'split',
          filterState: makeFilterState({ stalledOnly: true }),
          board: {
            query: { data: makeBoardData(), isLoading: false, error: null },
            cardsById: new Map(),
            availableLabels: [],
          },
        })}
      />,
    );
    expect(screen.getByTestId('split-board')).toBeInTheDocument();
  });

  it('renders SplitBoard with the selected project section key when data is available', () => {
    render(
      <AppBoardViewSwitch
        {...makeProps({
          view: 'split',
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
    expect(screen.getByTestId('split-board')).toHaveTextContent('proj-1');
  });

  it('forwards all SplitBoard props unchanged (filter state, metadata maps/sets, lane-collapse wiring)', () => {
    // opus レビュー指摘の変異(レーン折りたたみの no-op 化・collapsedLanes/
    // pendingDecisionIds/prLinksById の空値差し替え)を防ぐための直接検証。
    // 区別可能なマーカー値を使い、デフォルト値(空Map/空Set)とすり替わって
    // いないことまで見る。
    const pendingDecisionIds = new Set(['bdboard-pending-1']);
    const prLinksById = new Map<string, PrBadgeDto>([
      ['bdboard-pr-1', { ticketId: 'bdboard-pr-1', projectId: 'proj-1', url: 'https://example.test/1', state: 'open', checkStatus: null }],
    ]);
    const projectNames = new Map([['proj-1', 'Project One']]);
    const projectActiveSessions = new Map([['proj-1', 2]]);
    const wipLimitsOverrides = { inProgressWipLimit: 7 };
    const collapsedLanesSet = new Set(['in_progress' as const]);
    const onToggleLaneCollapse = vi.fn();
    const onCardClick = vi.fn();
    const filterState = makeFilterState({
      hideDone: true,
      stalledOnly: true,
      filter: { ...EMPTY_BOARD_FILTER, text: 'marker-text' },
      collapsedLanesSet,
      onToggleLaneCollapse,
    });

    render(
      <AppBoardViewSwitch
        {...makeProps({
          view: 'split',
          filterState,
          board: {
            query: { data: makeBoardData(), isLoading: false, error: null },
            cardsById: new Map(),
            availableLabels: [],
          },
          boardMeta: {
            projectNames,
            projectActiveSessions,
            pendingDecisionIds,
            prLinksById,
            wipLimitsOverrides,
            selectedProjectIdsJoined: 'proj-1',
          },
          onCardClick,
        })}
      />,
    );

    expect(splitBoardMock).toHaveBeenCalledTimes(1);
    const props = splitBoardMock.mock.calls.at(-1)?.[0];
    expect(props).toMatchObject({
      hideDone: true,
      stalledOnly: true,
      filter: filterState.filter,
      pendingDecisionIds,
      prLinksById,
      wipLimitsOverrides,
      collapsedLanes: collapsedLanesSet,
      onToggleLaneCollapse,
      onCardClick,
    });
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

  it('forwards all SplitBoard-specific props unchanged (metadata maps, lane-collapse wiring)', () => {
    const pendingDecisionIds = new Set(['bdboard-pending-split']);
    const prLinksById = new Map<string, PrBadgeDto>([
      ['bdboard-pr-split', { ticketId: 'bdboard-pr-split', projectId: 'proj-2', url: 'https://example.test/2', state: 'open', checkStatus: null }],
    ]);
    const wipLimitsOverrides = { inProgressWipLimit: 3 };
    const collapsedLanesSet = new Set(['awaiting_human' as const]);
    const onToggleLaneCollapse = vi.fn();
    const filterState = makeFilterState({
      hideDone: true,
      collapsedLanesSet,
      onToggleLaneCollapse,
    });

    render(
      <AppBoardViewSwitch
        {...makeProps({
          view: 'split',
          filterState,
          board: {
            query: { data: makeBoardData({ projects: [] }), isLoading: false, error: null },
            cardsById: new Map(),
            availableLabels: [],
          },
          boardMeta: {
            projectNames: new Map(),
            projectActiveSessions: new Map(),
            pendingDecisionIds,
            prLinksById,
            wipLimitsOverrides,
            selectedProjectIdsJoined: 'proj-2',
          },
        })}
      />,
    );

    const props = splitBoardMock.mock.calls.at(-1)?.[0];
    expect(props).toMatchObject({
      hideDone: true,
      pendingDecisionIds,
      prLinksById,
      wipLimitsOverrides,
      collapsedLanes: collapsedLanesSet,
      onToggleLaneCollapse,
    });
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

  it('forwards harnessStatuses, batchRun, and board metadata to NextUpView unchanged', () => {
    // opus レビュー指摘の変異「harnessStatuses が undefined に差し替わる」を
    // 直接検知する。harnessStatuses は undefined と「値はあるが空」を区別
    // できるよう、要素を持つ Map を渡して同一参照で届くことを見る。
    const harnessStatuses = new Map<string, ProjectHarnessStatusDto>([
      ['proj-1', {} as ProjectHarnessStatusDto],
    ]);
    const pendingDecisionIds = new Set(['bdboard-pending-next']);
    const prLinksById = new Map<string, PrBadgeDto>();
    const projectNames = new Map([['proj-1', 'Project One']]);
    const projectActiveSessions = new Map([['proj-1', 1]]);
    const batchRun = { id: 'marker-batch-run' } as unknown as NextUpRunLoopController;
    const onCardClick = vi.fn();

    render(
      <AppBoardViewSwitch
        {...makeProps({
          view: 'next',
          board: {
            query: { data: makeBoardData(), isLoading: false, error: null },
            cardsById: new Map(),
            availableLabels: [],
          },
          boardMeta: {
            projectNames,
            projectActiveSessions,
            pendingDecisionIds,
            prLinksById,
            wipLimitsOverrides: {},
            selectedProjectIdsJoined: 'proj-1',
          },
          onCardClick,
          nextUp: {
            limit: 5,
            onLimitChange: vi.fn(),
            showEpics: false,
            onShowEpicsChange: vi.fn(),
            batchRun,
            harnessStatuses,
          },
        })}
      />,
    );

    const props = nextUpViewMock.mock.calls.at(-1)?.[0];
    expect(props).toMatchObject({
      harnessStatuses,
      batchRun,
      projectNames,
      projectActiveSessions,
      pendingDecisionIds,
      prLinksById,
      onCardClick,
    });
  });

  it('forwards the actual availableLabels to BulkActionBar instead of defaulting to an empty array', () => {
    const availableLabels = ['bug', 'marker-label'];
    render(
      <AppBoardViewSwitch
        {...makeProps({
          view: 'split',
          board: {
            query: { data: undefined, isLoading: false, error: null },
            cardsById: new Map(),
            availableLabels,
          },
        })}
      />,
    );
    const props = bulkActionBarMock.mock.calls.at(-1)?.[0];
    expect(props).toMatchObject({ availableLabels });
  });

  it('passes the App-owned batchRun, board data and project names to BulkActionBar (bdboard-mkm1.2)', () => {
    const batchRun = { id: 'marker-bulk-batch-run' } as unknown as NextUpRunLoopController;
    const projectNames = new Map([['proj-1', 'Project One']]);
    const data = makeBoardData();
    render(
      <AppBoardViewSwitch
        {...makeProps({
          view: 'split',
          board: {
            query: { data, isLoading: false, error: null },
            cardsById: new Map(),
            availableLabels: [],
          },
          boardMeta: { ...makeProps().boardMeta, projectNames },
          nextUp: { ...makeProps().nextUp, batchRun },
        })}
      />,
    );
    const agentRun = bulkActionBarMock.mock.calls.at(-1)?.[0].agentRun;
    expect(agentRun?.batchRun).toBe(batchRun);
    expect(agentRun?.board).toBe(data);
    expect(agentRun?.projectNames).toBe(projectNames);
  });

  it('shows the "no merged data" message for next view when merged is null, but not for split view', () => {
    const { rerender } = render(
      <AppBoardViewSwitch
        {...makeProps({
          view: 'split',
          board: {
            query: { data: makeBoardData({ merged: null }), isLoading: false, error: null },
            cardsById: new Map(),
            availableLabels: [],
          },
        })}
      />,
    );
    expect(screen.queryByText('Next Up のデータがありません')).not.toBeInTheDocument();

    // Next Up はサーバーの merged モードで取得したデータ(board.query.data.merged)を
    // 描画に使うので、それが無いときの空メッセージ分岐は 'merged' タブ削除後も
    // 'next' に残る (bdboard-mkm1.1: サーバー側 merged モードは変えない)。
    rerender(
      <AppBoardViewSwitch
        {...makeProps({
          view: 'next',
          board: {
            query: { data: makeBoardData({ merged: null }), isLoading: false, error: null },
            cardsById: new Map(),
            availableLabels: [],
          },
        })}
      />,
    );
    expect(screen.getByText('Next Up のデータがありません')).toBeInTheDocument();
  });
});
