import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { BoardFilterPreset, BoardFilterPresetState } from '../uiPersistedState';
import { PresetControl } from './PresetControl';

const currentState: BoardFilterPresetState = {
  view: 'merged',
  selectedProjectIds: ['proj-1'],
  priorityCeiling: '1',
  issueTypes: ['bug'],
  labels: [],
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
    labels: [],
    filterText: 'alpha',
  },
  {
    id: 'preset-2',
    name: 'Next Up',
    view: 'next',
    selectedProjectIds: [],
    priorityCeiling: 'all',
    issueTypes: [],
    labels: [],
    filterText: '',
  },
];

function renderControl(
  overrides: Partial<{
    presets: BoardFilterPreset[];
    currentState: BoardFilterPresetState;
    saveIntentToken: number;
  }> = {},
) {
  const onPresetsChange = vi.fn<(presets: BoardFilterPreset[]) => void>();
  const onApplyPreset = vi.fn<(preset: BoardFilterPreset) => void>();

  const utils = render(
    <PresetControl
      presets={overrides.presets ?? samplePresets}
      onPresetsChange={onPresetsChange}
      currentState={overrides.currentState ?? currentState}
      onApplyPreset={onApplyPreset}
      saveIntentToken={overrides.saveIntentToken ?? 0}
    />,
  );

  return { ...utils, onPresetsChange, onApplyPreset };
}

async function openControl(user: ReturnType<typeof userEvent.setup>, name = '未選択') {
  await user.click(screen.getByRole('button', { name: `フィルタプリセット: ${name}` }));
}

describe('PresetControl', () => {
  it('merges選ぶ/保存/整理 into one control (no separate 管理 button)', async () => {
    const user = userEvent.setup();
    renderControl();

    expect(screen.queryByRole('button', { name: '管理' })).not.toBeInTheDocument();

    await openControl(user, 'P1バグだけ');
    const dialog = screen.getByRole('dialog', { name: 'フィルタプリセット' });
    expect(dialog).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^P1バグだけ/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '新規保存…' })).toBeInTheDocument();
  });

  it('applies a preset and closes the popover', async () => {
    const user = userEvent.setup();
    const { onApplyPreset } = renderControl();

    await openControl(user, 'P1バグだけ');
    await user.click(screen.getByRole('button', { name: /^Next Up/ }));

    expect(onApplyPreset).toHaveBeenCalledWith(samplePresets[1]);
    expect(screen.queryByRole('dialog', { name: 'フィルタプリセット' })).not.toBeInTheDocument();
  });

  it('marks the matching preset active, and shows 変更あり once the filter drifts', async () => {
    const user = userEvent.setup();
    const { rerender, onPresetsChange, onApplyPreset } = renderControl();

    await openControl(user, 'P1バグだけ');
    expect(screen.getByRole('button', { name: /^P1バグだけ/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.queryByText('変更あり')).not.toBeInTheDocument();

    rerender(
      <PresetControl
        presets={samplePresets}
        onPresetsChange={onPresetsChange}
        currentState={{ ...currentState, filterText: 'beta' }}
        onApplyPreset={onApplyPreset}
      />,
    );

    // 一致しなくなったので「選択中」ではなくなる。適用済みの記憶が無い初期表示では
    // どのプリセットもアクティブにならない。
    expect(screen.getByRole('button', { name: /^P1バグだけ/ })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('shows 変更あり and enables 上書き after applying then drifting', async () => {
    const user = userEvent.setup();
    const onApplyPreset = vi.fn();
    const onPresetsChange = vi.fn();
    const { rerender } = render(
      <PresetControl
        presets={samplePresets}
        onPresetsChange={onPresetsChange}
        currentState={currentState}
        onApplyPreset={onApplyPreset}
      />,
    );

    await openControl(user, 'P1バグだけ');
    await user.click(screen.getByRole('button', { name: /^P1バグだけ/ }));

    rerender(
      <PresetControl
        presets={samplePresets}
        onPresetsChange={onPresetsChange}
        currentState={{ ...currentState, filterText: 'beta' }}
        onApplyPreset={onApplyPreset}
      />,
    );

    await openControl(user, 'P1バグだけ');
    expect(screen.getByText('変更あり')).toBeInTheDocument();

    const overwrite = screen.getByRole('button', { name: '「P1バグだけ」を上書き' });
    expect(overwrite).toBeEnabled();
    await user.click(overwrite);

    expect(onPresetsChange).toHaveBeenCalledWith([
      { ...samplePresets[0], filterText: 'beta' },
      samplePresets[1],
    ]);
  });

  it('describes what is about to be saved', async () => {
    const user = userEvent.setup();
    renderControl();

    await openControl(user, 'P1バグだけ');
    expect(
      screen.getByText(/いまの絞り込み: ビュー: 統合 \/ プロジェクト1件 \/ P1以上/),
    ).toBeInTheDocument();
  });

  it('saves a new preset and rejects a duplicate name', async () => {
    const user = userEvent.setup();
    const { onPresetsChange } = renderControl();

    await openControl(user, 'P1バグだけ');
    await user.click(screen.getByRole('button', { name: '新規保存…' }));
    await user.type(screen.getByLabelText('新しいプリセットの名前'), 'Next Up');
    await user.click(screen.getByRole('button', { name: '保存' }));

    expect(screen.getByText('同じ名前のプリセットが既にあります')).toBeInTheDocument();
    expect(onPresetsChange).not.toHaveBeenCalled();

    await user.clear(screen.getByLabelText('新しいプリセットの名前'));
    await user.type(screen.getByLabelText('新しいプリセットの名前'), 'あたらしい');
    await user.click(screen.getByRole('button', { name: '保存' }));

    expect(onPresetsChange).toHaveBeenCalledTimes(1);
    const saved = onPresetsChange.mock.calls[0][0];
    expect(saved).toHaveLength(3);
    expect(saved[2]).toMatchObject({ name: 'あたらしい', ...currentState });
  });

  it('submits the name inputs with Enter', async () => {
    const user = userEvent.setup();
    const { onPresetsChange } = renderControl();

    await openControl(user, 'P1バグだけ');
    await user.click(screen.getByRole('button', { name: '新規保存…' }));
    await user.type(screen.getByLabelText('新しいプリセットの名前'), 'あたらしい{Enter}');

    expect(onPresetsChange).toHaveBeenCalledTimes(1);
    expect(onPresetsChange.mock.calls[0][0][2]).toMatchObject({ name: 'あたらしい' });
  });

  it('submits a rename with Enter', async () => {
    const user = userEvent.setup();
    const { onPresetsChange } = renderControl();

    await openControl(user, 'P1バグだけ');
    await user.click(screen.getByRole('button', { name: '「Next Up」の操作' }));
    await user.click(screen.getByRole('menuitem', { name: '名前を変更' }));

    const input = screen.getByLabelText('「Next Up」の新しい名前');
    await user.clear(input);
    await user.type(input, '次にやる{Enter}');

    expect(onPresetsChange).toHaveBeenCalledWith([
      samplePresets[0],
      { ...samplePresets[1], name: '次にやる' },
    ]);
  });

  it('opens straight into the new-save row when saveIntentToken increments', async () => {
    const onPresetsChange = vi.fn();
    const onApplyPreset = vi.fn();
    const { rerender } = render(
      <PresetControl
        presets={samplePresets}
        onPresetsChange={onPresetsChange}
        currentState={currentState}
        onApplyPreset={onApplyPreset}
        saveIntentToken={0}
      />,
    );

    expect(screen.queryByLabelText('新しいプリセットの名前')).not.toBeInTheDocument();

    rerender(
      <PresetControl
        presets={samplePresets}
        onPresetsChange={onPresetsChange}
        currentState={currentState}
        onApplyPreset={onApplyPreset}
        saveIntentToken={1}
      />,
    );

    expect(screen.getByLabelText('新しいプリセットの名前')).toBeInTheDocument();
  });

  it('renames a preset from the row menu', async () => {
    const user = userEvent.setup();
    const { onPresetsChange } = renderControl();

    await openControl(user, 'P1バグだけ');
    await user.click(screen.getByRole('button', { name: '「Next Up」の操作' }));
    await user.click(screen.getByRole('menuitem', { name: '名前を変更' }));

    const input = screen.getByLabelText('「Next Up」の新しい名前');
    await user.clear(input);
    await user.type(input, '次にやる');
    await user.click(screen.getByRole('button', { name: '決定' }));

    expect(onPresetsChange).toHaveBeenCalledWith([
      samplePresets[0],
      { ...samplePresets[1], name: '次にやる' },
    ]);
  });

  it('duplicates a preset with a distinct name', async () => {
    const user = userEvent.setup();
    const { onPresetsChange } = renderControl();

    await openControl(user, 'P1バグだけ');
    await user.click(screen.getByRole('button', { name: '「Next Up」の操作' }));
    await user.click(screen.getByRole('menuitem', { name: '複製' }));

    const next = onPresetsChange.mock.calls[0][0];
    expect(next).toHaveLength(3);
    expect(next[2].name).toBe('Next Up のコピー');
    expect(next[2].id).not.toBe(samplePresets[1].id);
  });

  it('marks exactly one preset as 既定', async () => {
    const user = userEvent.setup();
    const presets: BoardFilterPreset[] = [
      { ...samplePresets[0], isDefault: true },
      samplePresets[1],
    ];
    const { onPresetsChange } = renderControl({ presets });

    await openControl(user, 'P1バグだけ');
    expect(screen.getByText('既定')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '「Next Up」の操作' }));
    await user.click(screen.getByRole('menuitem', { name: '既定にする' }));

    const next = onPresetsChange.mock.calls[0][0];
    expect(next[0].isDefault).toBeUndefined();
    expect(next[1].isDefault).toBe(true);
  });

  it('clears 既定 when toggled off', async () => {
    const user = userEvent.setup();
    const presets: BoardFilterPreset[] = [
      { ...samplePresets[0], isDefault: true },
      samplePresets[1],
    ];
    const { onPresetsChange } = renderControl({ presets });

    await openControl(user, 'P1バグだけ');
    await user.click(screen.getByRole('button', { name: '「P1バグだけ」の操作' }));
    await user.click(screen.getByRole('menuitem', { name: '既定を解除' }));

    const next = onPresetsChange.mock.calls[0][0];
    expect(next.every((preset) => preset.isDefault === undefined)).toBe(true);
  });

  it('deletes a preset', async () => {
    const user = userEvent.setup();
    const { onPresetsChange } = renderControl();

    await openControl(user, 'P1バグだけ');
    await user.click(screen.getByRole('button', { name: '「Next Up」の操作' }));
    await user.click(screen.getByRole('menuitem', { name: '削除' }));

    expect(onPresetsChange).toHaveBeenCalledWith([samplePresets[0]]);
  });

  it('invites saving when there are no presets yet', async () => {
    const user = userEvent.setup();
    renderControl({ presets: [] });

    await openControl(user);
    expect(
      screen.getByText('プリセットはまだありません。いまの絞り込みを保存できます。'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /を上書き$/ })).not.toBeInTheDocument();
  });
});
