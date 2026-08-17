import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { BoardFilterBar } from './BoardFilterBar';

function renderBar(
  overrides: Partial<{
    priorityCeiling: 'all' | '0' | '1' | '2' | '3' | '4';
    issueTypes: string[];
    labels: string[];
    availableLabels: string[];
    filterText: string;
    onPriorityCeilingChange: (choice: 'all' | '0' | '1' | '2' | '3' | '4') => void;
    onIssueTypesChange: (types: string[]) => void;
    onLabelsChange: (labels: string[]) => void;
    onFilterTextChange: (text: string) => void;
  }> = {},
) {
  const onPriorityCeilingChange = overrides.onPriorityCeilingChange ?? vi.fn();
  const onIssueTypesChange = overrides.onIssueTypesChange ?? vi.fn();
  const onLabelsChange = overrides.onLabelsChange ?? vi.fn();
  const onFilterTextChange = overrides.onFilterTextChange ?? vi.fn();

  render(
    <BoardFilterBar
      priorityCeiling={overrides.priorityCeiling ?? 'all'}
      onPriorityCeilingChange={onPriorityCeilingChange}
      issueTypes={overrides.issueTypes ?? []}
      onIssueTypesChange={onIssueTypesChange}
      labels={overrides.labels ?? []}
      onLabelsChange={onLabelsChange}
      availableLabels={overrides.availableLabels ?? ['human', 'needs-review']}
      filterText={overrides.filterText ?? ''}
      onFilterTextChange={onFilterTextChange}
    />,
  );

  return {
    onPriorityCeilingChange,
    onIssueTypesChange,
    onLabelsChange,
    onFilterTextChange,
  };
}

describe('BoardFilterBar', () => {
  it('calls onPriorityCeilingChange when select changes', () => {
    const { onPriorityCeilingChange } = renderBar();

    fireEvent.change(screen.getByLabelText('優先度上限'), {
      target: { value: '2' },
    });

    expect(onPriorityCeilingChange).toHaveBeenCalledWith('2');
  });

  it('toggles issue type chips on and off', async () => {
    const user = userEvent.setup();
    const onIssueTypesChange = vi.fn();

    const { rerender } = render(
      <BoardFilterBar
        priorityCeiling="all"
        onPriorityCeilingChange={vi.fn()}
        issueTypes={[]}
        onIssueTypesChange={onIssueTypesChange}
        labels={[]}
        onLabelsChange={vi.fn()}
        availableLabels={['human']}
        filterText=""
        onFilterTextChange={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'bug' }));
    expect(onIssueTypesChange).toHaveBeenCalledWith(['bug']);

    rerender(
      <BoardFilterBar
        priorityCeiling="all"
        onPriorityCeilingChange={vi.fn()}
        issueTypes={['bug']}
        onIssueTypesChange={onIssueTypesChange}
        labels={[]}
        onLabelsChange={vi.fn()}
        availableLabels={['human']}
        filterText=""
        onFilterTextChange={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'bug' }));
    expect(onIssueTypesChange).toHaveBeenLastCalledWith([]);
  });

  it('toggles label chips on and off', async () => {
    const user = userEvent.setup();
    const onLabelsChange = vi.fn();

    const { rerender } = render(
      <BoardFilterBar
        priorityCeiling="all"
        onPriorityCeilingChange={vi.fn()}
        issueTypes={[]}
        onIssueTypesChange={vi.fn()}
        labels={[]}
        onLabelsChange={onLabelsChange}
        availableLabels={['human', 'needs-review']}
        filterText=""
        onFilterTextChange={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'human' }));
    expect(onLabelsChange).toHaveBeenCalledWith(['human']);

    rerender(
      <BoardFilterBar
        priorityCeiling="all"
        onPriorityCeilingChange={vi.fn()}
        issueTypes={[]}
        onIssueTypesChange={vi.fn()}
        labels={['human']}
        onLabelsChange={onLabelsChange}
        availableLabels={['human', 'needs-review']}
        filterText=""
        onFilterTextChange={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'human' }));
    expect(onLabelsChange).toHaveBeenLastCalledWith([]);
  });

  it('hides label section when availableLabels is empty', () => {
    renderBar({ availableLabels: [] });

    expect(screen.queryByRole('button', { name: 'human' })).not.toBeInTheDocument();
  });

  it('marks selected issue type chips as pressed', () => {
    renderBar({ issueTypes: ['feature', 'task'] });

    expect(screen.getByRole('button', { name: 'feature' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('button', { name: 'bug' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('calls onFilterTextChange when text is entered', () => {
    const { onFilterTextChange } = renderBar();

    fireEvent.change(screen.getByRole('searchbox', { name: 'チケットの絞り込み' }), {
      target: { value: 'alpha' },
    });

    expect(onFilterTextChange).toHaveBeenCalledWith('alpha');
  });

  it('hides clear button when filter is inactive', () => {
    renderBar();

    expect(
      screen.queryByRole('button', { name: 'フィルタ解除' }),
    ).not.toBeInTheDocument();
  });

  it('shows clear button when filter is active and resets all values', async () => {
    const user = userEvent.setup();
    const onPriorityCeilingChange = vi.fn();
    const onIssueTypesChange = vi.fn();
    const onLabelsChange = vi.fn();
    const onFilterTextChange = vi.fn();

    renderBar({
      priorityCeiling: '1',
      issueTypes: ['bug'],
      labels: ['human'],
      filterText: 'alpha',
      onPriorityCeilingChange,
      onIssueTypesChange,
      onLabelsChange,
      onFilterTextChange,
    });

    await user.click(screen.getByRole('button', { name: 'フィルタ解除' }));

    expect(onPriorityCeilingChange).toHaveBeenCalledWith('all');
    expect(onIssueTypesChange).toHaveBeenCalledWith([]);
    expect(onLabelsChange).toHaveBeenCalledWith([]);
    expect(onFilterTextChange).toHaveBeenCalledWith('');
  });
});
