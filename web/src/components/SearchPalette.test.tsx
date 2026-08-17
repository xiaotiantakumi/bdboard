import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TicketSearchResultDto } from '../api';
import { searchTickets } from '../api';
import type { PaletteAction } from '../paletteActions';
import type { RecentTicketEntry } from '../uiPersistedState';
import { SearchPalette } from './SearchPalette';

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    searchTickets: vi.fn(),
  };
});

const mockSearchTickets = vi.mocked(searchTickets);

const sampleResults: TicketSearchResultDto[] = [
  {
    id: 'bdboard-alpha',
    projectId: 'proj-a',
    projectName: 'Alpha',
    title: 'First result',
    status: 'open',
    priority: 1,
    issueType: 'task',
  },
  {
    id: 'bdboard-beta',
    projectId: 'proj-b',
    projectName: 'Beta',
    title: 'Second result',
    status: 'in_progress',
    priority: 2,
    issueType: 'bug',
  },
];

const sampleActions: PaletteAction[] = [
  {
    id: 'view:hygiene',
    label: 'ビュー: 健全性',
    keywords: 'hygiene 健全性',
    group: 'ビュー',
    onSelect: vi.fn(),
  },
  {
    id: 'panel:chat',
    label: 'チャットを開く',
    keywords: 'chat チャット',
    group: 'パネル',
    onSelect: vi.fn(),
  },
  {
    id: 'board:toggle-hide-done',
    label: 'doneレーン表示切替',
    keywords: 'done レーン',
    group: 'ボード',
    detail: '現在: 隠す',
    onSelect: vi.fn(),
  },
];

function renderPalette(
  onSelect = vi.fn(),
  onClose = vi.fn(),
  actions: PaletteAction[] = sampleActions,
  recentTickets?: RecentTicketEntry[],
) {
  return {
    onSelect,
    onClose,
    actions,
    recentTickets,
    ...render(
      <SearchPalette
        onClose={onClose}
        onSelect={onSelect}
        actions={actions}
        recentTickets={recentTickets}
      />,
    ),
  };
}

function getSearchInput(): HTMLInputElement {
  return screen.getByRole('searchbox', { name: '検索クエリ' });
}

describe('SearchPalette', () => {
  beforeEach(() => {
    mockSearchTickets.mockReset();
    mockSearchTickets.mockResolvedValue(sampleResults);
    for (const action of sampleActions) {
      vi.mocked(action.onSelect).mockReset();
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('focuses the search input on open', () => {
    renderPalette();

    expect(getSearchInput()).toHaveFocus();
  });

  it('lists palette actions before typing', () => {
    renderPalette();

    expect(screen.getByText('ビュー: 健全性')).toBeInTheDocument();
    expect(screen.getByText('チャットを開く')).toBeInTheDocument();
    expect(screen.getByText('doneレーン表示切替')).toBeInTheDocument();
    expect(mockSearchTickets).not.toHaveBeenCalled();
  });

  it('runs a palette action on click', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const actions = [
      {
        ...sampleActions[1],
        onSelect: vi.fn(),
      },
    ];
    renderPalette(vi.fn(), onClose, actions);

    await user.click(screen.getByText('チャットを開く'));

    expect(actions[0].onSelect).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('runs the highlighted palette action on Enter without a ticket query', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderPalette(vi.fn(), onClose);

    await user.keyboard('{ArrowDown}{Enter}');

    expect(sampleActions[1].onSelect).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(mockSearchTickets).not.toHaveBeenCalled();
  });

  it('filters palette actions locally by query', async () => {
    const user = userEvent.setup();
    renderPalette();

    await user.type(getSearchInput(), '健全性');

    expect(screen.getByText('ビュー: 健全性')).toBeInTheDocument();
    expect(screen.queryByText('チャットを開く')).not.toBeInTheDocument();
  });

  it('debounces rapid input into a single search for the latest query', async () => {
    renderPalette();
    const input = getSearchInput();

    fireEvent.change(input, { target: { value: 'a' } });
    fireEvent.change(input, { target: { value: 'al' } });
    fireEvent.change(input, { target: { value: 'alpha' } });

    expect(mockSearchTickets).not.toHaveBeenCalled();

    await waitFor(() => {
      expect(mockSearchTickets).toHaveBeenCalledTimes(1);
    });
    expect(mockSearchTickets).toHaveBeenCalledWith('alpha', 30);
  });

  it('shows ticket results after debounced search input', async () => {
    const user = userEvent.setup();
    renderPalette();

    await user.type(getSearchInput(), 'alpha');

    expect(await screen.findByText('First result')).toBeInTheDocument();
    expect(screen.getByText('Alpha')).toBeInTheDocument();
    expect(screen.getByText('bdboard-alpha')).toBeInTheDocument();
    expect(screen.getByText('P1')).toBeInTheDocument();
  });

  it('lists matching actions before ticket hits when both match', async () => {
    const user = userEvent.setup();
    const actions: PaletteAction[] = [
      {
        id: 'view:merged',
        label: 'ビュー: 統合',
        keywords: 'merged alpha 統合',
        group: 'ビュー',
        onSelect: vi.fn(),
      },
      ...sampleActions.slice(1),
    ];
    renderPalette(vi.fn(), vi.fn(), actions);

    await user.type(getSearchInput(), 'alpha');

    const options = screen.getAllByRole('option');
    expect(options[0]).toHaveTextContent('ビュー: 統合');
    expect(await screen.findByText('First result')).toBeInTheDocument();
  });

  it('calls onSelect with the highlighted ticket on Enter', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    renderPalette(onSelect);

    await user.type(getSearchInput(), 'alpha');
    await screen.findByText('Second result');

    await user.keyboard('{ArrowDown}{Enter}');

    expect(onSelect).toHaveBeenCalledWith('bdboard-beta');
  });

  it('moves the highlight back up with ArrowUp', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    renderPalette(onSelect);

    await user.type(getSearchInput(), 'alpha');
    await screen.findByText('Second result');

    await user.keyboard('{ArrowDown}{ArrowUp}{Enter}');

    expect(onSelect).toHaveBeenCalledWith('bdboard-alpha');
  });

  it('closes on Escape', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderPalette(vi.fn(), onClose);

    await user.keyboard('{Escape}');

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('shows empty state when search returns no hits and no actions match', async () => {
    const user = userEvent.setup();
    mockSearchTickets.mockResolvedValue([]);
    renderPalette();

    await user.type(getSearchInput(), 'missing-xyz');

    expect(
      await screen.findByText('該当するコマンドやチケットがありません'),
    ).toBeInTheDocument();
  });

  it('shows an error message when the search request fails', async () => {
    const user = userEvent.setup();
    mockSearchTickets.mockRejectedValue(new Error('検索に失敗しました'));
    renderPalette();

    await user.type(getSearchInput(), 'boom');

    expect(await screen.findByText('検索に失敗しました')).toBeInTheDocument();
  });

  it('shows recent tickets when query is empty', () => {
    const recentTickets: RecentTicketEntry[] = [
      {
        id: 'bdboard-recent-1',
        title: 'Recent ticket one',
        projectName: 'Recent Project',
      },
    ];
    renderPalette(vi.fn(), vi.fn(), sampleActions, recentTickets);

    expect(screen.getByText('最近開いたチケット')).toBeInTheDocument();
    expect(screen.getByText('bdboard-recent-1')).toBeInTheDocument();
    expect(screen.getByText('Recent ticket one')).toBeInTheDocument();
    expect(screen.getByText('Recent Project')).toBeInTheDocument();
    expect(mockSearchTickets).not.toHaveBeenCalled();
  });

  it('opens a recent ticket on click', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const onClose = vi.fn();
    const recentTickets: RecentTicketEntry[] = [
      {
        id: 'bdboard-recent-1',
        title: 'Recent ticket one',
        projectName: 'Recent Project',
      },
    ];
    renderPalette(onSelect, onClose, sampleActions, recentTickets);

    await user.click(screen.getByText('Recent ticket one'));

    expect(onSelect).toHaveBeenCalledWith('bdboard-recent-1');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('opens a recent ticket on arrow keys and Enter', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const onClose = vi.fn();
    const recentTickets: RecentTicketEntry[] = [
      {
        id: 'bdboard-recent-1',
        title: 'Recent ticket one',
        projectName: 'Recent Project',
      },
      {
        id: 'bdboard-recent-2',
        title: 'Recent ticket two',
        projectName: 'Recent Project',
      },
    ];
    renderPalette(onSelect, onClose, [], recentTickets);

    await user.keyboard('{ArrowDown}{Enter}');

    expect(onSelect).toHaveBeenCalledWith('bdboard-recent-2');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('hides recent tickets when query is entered', async () => {
    const user = userEvent.setup();
    const recentTickets: RecentTicketEntry[] = [
      {
        id: 'bdboard-recent-1',
        title: 'Recent ticket one',
        projectName: 'Recent Project',
      },
    ];
    renderPalette(vi.fn(), vi.fn(), sampleActions, recentTickets);

    expect(screen.getByText('Recent ticket one')).toBeInTheDocument();

    await user.type(getSearchInput(), 'alpha');

    expect(screen.queryByText('Recent ticket one')).not.toBeInTheDocument();
    expect(screen.queryByText('最近開いたチケット')).not.toBeInTheDocument();
    expect(await screen.findByText('First result')).toBeInTheDocument();
  });
});
