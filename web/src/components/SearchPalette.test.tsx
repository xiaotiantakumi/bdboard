import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TicketSearchResultDto } from '../api';
import { searchTickets } from '../api';
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

function renderPalette(onSelect = vi.fn(), onClose = vi.fn()) {
  return {
    onSelect,
    onClose,
    ...render(<SearchPalette onClose={onClose} onSelect={onSelect} />),
  };
}

function getSearchInput(): HTMLInputElement {
  return screen.getByRole('searchbox', { name: '検索クエリ' });
}

describe('SearchPalette', () => {
  beforeEach(() => {
    mockSearchTickets.mockReset();
    mockSearchTickets.mockResolvedValue(sampleResults);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('focuses the search input on open', () => {
    renderPalette();

    expect(getSearchInput()).toHaveFocus();
  });

  it('debounces rapid input into a single search for the latest query', async () => {
    renderPalette();
    const input = getSearchInput();

    // 3 回続けて打ち込んでも、走るのは最後のクエリの 1 回だけ。
    fireEvent.change(input, { target: { value: 'a' } });
    fireEvent.change(input, { target: { value: 'al' } });
    fireEvent.change(input, { target: { value: 'alpha' } });

    // debounce 前なので、まだ API は叩かれていない。
    expect(mockSearchTickets).not.toHaveBeenCalled();

    await waitFor(() => {
      expect(mockSearchTickets).toHaveBeenCalledTimes(1);
    });
    expect(mockSearchTickets).toHaveBeenCalledWith('alpha', 30);
  });

  it('shows results after debounced search input', async () => {
    const user = userEvent.setup();
    renderPalette();

    await user.type(getSearchInput(), 'alpha');

    expect(await screen.findByText('First result')).toBeInTheDocument();
    expect(screen.getByText('Alpha')).toBeInTheDocument();
    expect(screen.getByText('bdboard-alpha')).toBeInTheDocument();
    expect(screen.getByText('P1')).toBeInTheDocument();
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

  it('shows empty state when search returns no hits', async () => {
    const user = userEvent.setup();
    mockSearchTickets.mockResolvedValue([]);
    renderPalette();

    await user.type(getSearchInput(), 'missing');

    expect(
      await screen.findByText('該当するチケットがありません'),
    ).toBeInTheDocument();
  });

  it('shows an error message when the search request fails', async () => {
    const user = userEvent.setup();
    mockSearchTickets.mockRejectedValue(new Error('検索に失敗しました'));
    renderPalette();

    await user.type(getSearchInput(), 'boom');

    expect(await screen.findByText('検索に失敗しました')).toBeInTheDocument();
  });
});
