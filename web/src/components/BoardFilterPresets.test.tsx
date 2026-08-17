import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { BoardFilterPresets } from './BoardFilterPresets';
import type { BoardFilterPreset, BoardFilterPresetState } from '../uiPersistedState';

const currentState: BoardFilterPresetState = {
  view: 'merged',
  selectedProjectIds: ['proj-1'],
  priorityCeiling: '1',
  issueTypes: ['bug'],
  filterText: 'alpha',
};

const samplePresets: BoardFilterPreset[] = [
  {
    id: 'preset-1',
    name: 'P1バグだけ',
    view: 'merged',
    selectedProjectIds: ['proj-1'],
    priorityCeiling: '1',
    issueTypes: ['bug'],
    filterText: 'alpha',
  },
  {
    id: 'preset-2',
    name: 'Next Up',
    view: 'next',
    selectedProjectIds: [],
    priorityCeiling: 'all',
    issueTypes: [],
    filterText: '',
  },
];

function renderPresets(
  overrides: Partial<{
    presets: BoardFilterPreset[];
    currentState: BoardFilterPresetState;
    onPresetsChange: (presets: BoardFilterPreset[]) => void;
    onApplyPreset: (preset: BoardFilterPreset) => void;
  }> = {},
) {
  const onPresetsChange = overrides.onPresetsChange ?? vi.fn();
  const onApplyPreset = overrides.onApplyPreset ?? vi.fn();

  render(
    <BoardFilterPresets
      presets={overrides.presets ?? samplePresets}
      onPresetsChange={onPresetsChange}
      currentState={overrides.currentState ?? currentState}
      onApplyPreset={onApplyPreset}
    />,
  );

  return { onPresetsChange, onApplyPreset };
}

describe('BoardFilterPresets', () => {
  it('applies a preset on one-tap click', async () => {
    const user = userEvent.setup();
    const onApplyPreset = vi.fn();
    renderPresets({ onApplyPreset });

    await user.click(screen.getByRole('button', { name: 'Next Up' }));

    expect(onApplyPreset).toHaveBeenCalledWith(samplePresets[1]);
  });

  it('marks the matching preset as active', () => {
    renderPresets();

    expect(screen.getByRole('button', { name: 'P1バグだけ' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('button', { name: 'Next Up' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('saves the current state as a named preset', async () => {
    const user = userEvent.setup();
    const onPresetsChange = vi.fn();
    renderPresets({ presets: [], onPresetsChange });

    await user.click(screen.getByText('管理'));
    await user.type(screen.getByLabelText('現在の状態を保存'), '朝の確認');
    await user.click(screen.getByRole('button', { name: '保存' }));

    expect(onPresetsChange).toHaveBeenCalledTimes(1);
    const nextPresets = onPresetsChange.mock.calls[0]?.[0] as BoardFilterPreset[];
    expect(nextPresets).toHaveLength(1);
    expect(nextPresets[0]?.name).toBe('朝の確認');
    expect(nextPresets[0]?.view).toBe('merged');
    expect(nextPresets[0]?.selectedProjectIds).toEqual(['proj-1']);
    expect(nextPresets[0]?.priorityCeiling).toBe('1');
    expect(nextPresets[0]?.issueTypes).toEqual(['bug']);
    expect(nextPresets[0]?.filterText).toBe('alpha');
    expect(nextPresets[0]?.id).toEqual(expect.any(String));
  });

  it('deletes a preset from the manage panel', async () => {
    const user = userEvent.setup();
    const onPresetsChange = vi.fn();
    renderPresets({ onPresetsChange });

    await user.click(screen.getByText('管理'));
    await user.click(screen.getAllByRole('button', { name: '削除' })[0]!);

    expect(onPresetsChange).toHaveBeenCalledWith([samplePresets[1]]);
  });
});
