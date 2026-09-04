import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { BoardFilterPreset, BoardFilterPresetState } from '../uiPersistedState';
import { ViewToolbar } from './ViewToolbar';

const emptyPresetState: BoardFilterPresetState = {
  view: 'merged',
  selectedProjectIds: [],
  priorityCeiling: 'all',
  issueTypes: [],
  labels: [],
  filterText: '',
  hideDone: true,
  stalledOnly: false,
};

function renderToolbar(overrides?: Partial<React.ComponentProps<typeof ViewToolbar>>) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const props: React.ComponentProps<typeof ViewToolbar> = {
    view: 'merged',
    boardFilterPresets: [] as BoardFilterPreset[],
    onBoardFilterPresetsChange: vi.fn(),
    boardFilterPresetState: emptyPresetState,
    onApplyBoardFilterPreset: vi.fn(),
    hideDone: false,
    onHideDoneChange: vi.fn(),
    stalledOnly: false,
    onStalledOnlyChange: vi.fn(),
    totalSessionCount: 2,
    activeSessionCount: 1,
    onOpenSessionList: vi.fn(),
    onRefresh: vi.fn(),
    isRefreshing: false,
    chatAvailable: false,
    onOpenChat: vi.fn(),
    presetSaveIntentToken: 0,
    ...overrides,
  };
  render(
    <QueryClientProvider client={queryClient}>
      <ViewToolbar {...props} />
    </QueryClientProvider>,
  );
  return props;
}

describe('ViewToolbar filter chips a11y', () => {
  it('marks active filter chips with aria-pressed', () => {
    renderToolbar({ hideDone: true, stalledOnly: false });

    expect(screen.getByRole('button', { name: /done レーンを隠す/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('button', { name: /滞留のみ表示/ })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('toggles hideDone via filter chip click', async () => {
    const user = userEvent.setup();
    const onHideDoneChange = vi.fn();
    renderToolbar({ onHideDoneChange });

    await user.click(screen.getByRole('button', { name: /done レーンを隠す/ }));

    expect(onHideDoneChange).toHaveBeenCalledWith(true);
  });

  it('hides board filter chips outside merged/split views', () => {
    renderToolbar({ view: 'next' });

    expect(screen.queryByRole('button', { name: /done レーンを隠す/ })).not.toBeInTheDocument();
  });
});
