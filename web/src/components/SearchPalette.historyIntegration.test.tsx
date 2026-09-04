import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useMemo, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SearchPalette } from './SearchPalette';
import { useTicketDeepLink } from '../hooks/useTicketDeepLink';
import type { PaletteAction } from '../paletteActions';
import type { RecentTicketEntry, ViewMode } from '../uiPersistedState';

interface HistoryHarnessProps {
  noopActionOnSelect?: ReturnType<typeof vi.fn>;
  recentTickets?: RecentTicketEntry[];
}

function HistoryHarness({
  noopActionOnSelect = vi.fn(),
  recentTickets = [
    {
      id: 'bdboard-z',
      title: 'Ticket Z',
      projectName: 'Proj',
    },
  ],
}: HistoryHarnessProps) {
  const [view, setView] = useState<ViewMode>('merged');
  const [searchOpen, setSearchOpen] = useState(false);
  const { selectedTicketId, selectTicket, closeDetail } = useTicketDeepLink({
    view,
    onViewChange: setView,
  });

  const actions = useMemo<PaletteAction[]>(
    () => [
      {
        id: 'board:noop',
        label: 'No-op action',
        keywords: 'noop',
        group: 'ボード',
        onSelect: noopActionOnSelect,
      },
    ],
    [noopActionOnSelect],
  );

  return (
    <div>
      <div data-testid="selected-ticket">{selectedTicketId ?? 'null'}</div>
      <button type="button" onClick={() => selectTicket('bdboard-a')}>
        Open ticket A
      </button>
      <button type="button" onClick={() => setSearchOpen(true)}>
        Open palette
      </button>
      <button type="button" onClick={closeDetail}>
        Close detail
      </button>
      {searchOpen && (
        <SearchPalette
          onClose={() => setSearchOpen(false)}
          onSelect={selectTicket}
          actions={actions}
          recentTickets={recentTickets}
        />
      )}
    </div>
  );
}

describe('SearchPalette history integration', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', '/');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('closes detail in one back after a URL-preserving palette action (path A)', async () => {
    const user = userEvent.setup();
    const noopActionOnSelect = vi.fn();

    render(<HistoryHarness noopActionOnSelect={noopActionOnSelect} />);

    await user.click(screen.getByRole('button', { name: 'Open ticket A' }));
    await waitFor(() => {
      expect(window.location.hash).toBe('#ticket=bdboard-a');
    });

    await user.click(screen.getByRole('button', { name: 'Open palette' }));
    await user.click(screen.getByText('No-op action'));

    await waitFor(() => {
      expect(noopActionOnSelect).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByText('No-op action')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Close detail' }));

    await waitFor(() => {
      expect(window.location.hash).toBe('');
    });
    expect(screen.getByTestId('selected-ticket')).toHaveTextContent('null');
  });

  it('does not reopen ticket A after selecting ticket Z from the palette (path B)', async () => {
    const user = userEvent.setup();

    render(<HistoryHarness />);

    await user.click(screen.getByRole('button', { name: 'Open ticket A' }));
    await waitFor(() => {
      expect(window.location.hash).toBe('#ticket=bdboard-a');
    });

    await user.click(screen.getByRole('button', { name: 'Open palette' }));
    await user.click(screen.getByText('Ticket Z'));

    await waitFor(() => {
      expect(window.location.hash).toBe('#ticket=bdboard-z');
    });
    expect(screen.getByTestId('selected-ticket')).toHaveTextContent('bdboard-z');

    await user.click(screen.getByRole('button', { name: 'Close detail' }));

    await waitFor(() => {
      expect(window.location.hash).toBe('');
    });
    expect(window.location.hash).not.toBe('#ticket=bdboard-a');
    expect(screen.getByTestId('selected-ticket')).toHaveTextContent('null');
  });

  it('does not accumulate dead palette entries (path C)', async () => {
    const user = userEvent.setup();
    const noopActionOnSelect = vi.fn();

    render(<HistoryHarness noopActionOnSelect={noopActionOnSelect} />);

    await user.click(screen.getByRole('button', { name: 'Open ticket A' }));
    await waitFor(() => {
      expect(window.location.hash).toBe('#ticket=bdboard-a');
    });

    for (let i = 0; i < 3; i += 1) {
      await user.click(screen.getByRole('button', { name: 'Open palette' }));
      await user.click(screen.getByText('No-op action'));
      await waitFor(() => {
        expect(noopActionOnSelect).toHaveBeenCalledTimes(i + 1);
      });
    }

    await user.click(screen.getByRole('button', { name: 'Close detail' }));

    await waitFor(() => {
      expect(window.location.hash).toBe('');
    });
    expect(screen.getByTestId('selected-ticket')).toHaveTextContent('null');
  });

  it('opens a ticket from the board via palette and closes in one back', async () => {
    const user = userEvent.setup();

    render(<HistoryHarness />);

    await user.click(screen.getByRole('button', { name: 'Open palette' }));
    await user.click(screen.getByText('Ticket Z'));

    await waitFor(() => {
      expect(window.location.hash).toBe('#ticket=bdboard-z');
    });
    expect(screen.getByTestId('selected-ticket')).toHaveTextContent('bdboard-z');

    await user.click(screen.getByRole('button', { name: 'Close detail' }));

    await waitFor(() => {
      expect(window.location.hash).toBe('');
    });
    expect(screen.getByTestId('selected-ticket')).toHaveTextContent('null');
  });
});
