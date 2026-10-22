import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { EMPTY_BOARD_FILTER } from '../../boardFilter';
import type { BoardFilterState } from '../../hooks/useBoardFilterState';
import { HeaderFilterMenu, countHeaderFilters } from './HeaderFilterMenu';

function makeState(overrides: Partial<BoardFilterState> = {}): BoardFilterState {
  return {
    priorityCeiling: 'all',
    setPriorityCeiling: vi.fn(),
    issueTypes: [],
    setIssueTypes: vi.fn(),
    labels: [],
    setLabels: vi.fn(),
    filterText: '',
    setFilterText: vi.fn(),
    hideDone: true,
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

function Harness({ state }: { state: BoardFilterState }) {
  const [open, setOpen] = useState(false);
  return (
    <HeaderFilterMenu
      filterState={state}
      availableLabels={['ui']}
      presets={{
        list: [],
        onChange: vi.fn(),
        state: {} as never,
        onApply: vi.fn(),
        saveIntentToken: 0,
      }}
      open={open}
      onOpenChange={setOpen}
      showButton
    />
  );
}

describe('countHeaderFilters (bdboard-gyvv)', () => {
  it('does not count the default state, the search text, or the default hideDone', () => {
    expect(countHeaderFilters(makeState({ filterText: 'abc' }))).toBe(0);
  });

  it('counts priority, types, labels, stalledOnly and a non-default hideDone', () => {
    expect(
      countHeaderFilters(
        makeState({
          priorityCeiling: '1',
          issueTypes: ['bug', 'task'],
          labels: ['ui'],
          stalledOnly: true,
          hideDone: false,
        }),
      ),
    ).toBe(6);
  });
});

describe('HeaderFilterMenu (bdboard-gyvv)', () => {
  it('shows the badge count on the button and opens the popover with the filter controls', async () => {
    const user = userEvent.setup();
    render(<Harness state={makeState({ issueTypes: ['bug'], stalledOnly: true })} />);

    const button = screen.getByRole('button', { name: 'フィルタ (2件適用中)' });
    expect(screen.queryByRole('dialog', { name: 'フィルタ' })).not.toBeInTheDocument();

    await user.click(button);

    expect(screen.getByRole('dialog', { name: 'フィルタ' })).toBeInTheDocument();
    expect(screen.getByLabelText('優先度上限')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '滞留のみ表示' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('button', { name: 'done レーンを隠す' })).toBeInTheDocument();
  });
});
