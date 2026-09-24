import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoardFilterPreset } from '../uiPersistedState';
import { UI_STORAGE_KEYS } from '../uiPersistedState';
import { useAppFilterPresets, type AppFilterPresetsParams } from './useAppFilterPresets';

function baseParams(overrides: Partial<AppFilterPresetsParams> = {}): AppFilterPresetsParams {
  return {
    view: 'merged',
    selectedProjectIds: ['proj-1'],
    priorityCeiling: 'all',
    issueTypes: [],
    labels: [],
    filterText: '',
    hideDone: true,
    stalledOnly: false,
    setView: vi.fn(),
    setSelectedProjectIds: vi.fn(),
    setPriorityCeiling: vi.fn(),
    setIssueTypes: vi.fn(),
    setLabels: vi.fn(),
    setFilterText: vi.fn(),
    setHideDone: vi.fn(),
    setStalledOnly: vi.fn(),
    boardFilterPresets: [],
    ...overrides,
  };
}

function makePreset(overrides: Partial<BoardFilterPreset> = {}): BoardFilterPreset {
  return {
    id: 'preset-1',
    name: 'Preset',
    view: 'merged',
    selectedProjectIds: [],
    priorityCeiling: 'all',
    issueTypes: [],
    labels: [],
    filterText: '',
    hideDone: true,
    stalledOnly: false,
    ...overrides,
  };
}

beforeEach(() => {
  localStorage.clear();
});

describe('useAppFilterPresets', () => {
  it('boardFilterPresetState reflects the current input values (one distinct value per field)', () => {
    const params = baseParams({
      view: 'split',
      selectedProjectIds: ['proj-marker-a', 'proj-marker-b'],
      priorityCeiling: '2',
      issueTypes: ['bug', 'task'],
      labels: ['urgent'],
      filterText: 'marker-filter-text',
      hideDone: false,
      stalledOnly: true,
    });

    const { result } = renderHook(() => useAppFilterPresets(params));

    expect(result.current.boardFilterPresetState).toEqual({
      view: 'split',
      selectedProjectIds: ['proj-marker-a', 'proj-marker-b'],
      priorityCeiling: '2',
      issueTypes: ['bug', 'task'],
      labels: ['urgent'],
      filterText: 'marker-filter-text',
      hideDone: false,
      stalledOnly: true,
    });
  });

  it('keeps the same boardFilterPresetState reference across a rerender with unchanged inputs', () => {
    const params = baseParams();
    const { result, rerender } = renderHook(
      (p: AppFilterPresetsParams) => useAppFilterPresets(p),
      { initialProps: params },
    );
    const first = result.current.boardFilterPresetState;

    rerender({ ...params });

    expect(result.current.boardFilterPresetState).toBe(first);
  });

  it('produces a new boardFilterPresetState reference when an input value changes', () => {
    const params = baseParams({ filterText: 'a' });
    const { result, rerender } = renderHook(
      (p: AppFilterPresetsParams) => useAppFilterPresets(p),
      { initialProps: params },
    );
    const first = result.current.boardFilterPresetState;

    rerender({ ...params, filterText: 'b' });

    expect(result.current.boardFilterPresetState).not.toBe(first);
    expect(result.current.boardFilterPresetState.filterText).toBe('b');
  });

  it('handleApplyBoardFilterPreset calls every setter with the matching field from the preset', () => {
    const params = baseParams();
    const { result } = renderHook(() => useAppFilterPresets(params));

    const preset = makePreset({
      view: 'digest',
      selectedProjectIds: ['proj-marker-a', 'proj-marker-b'],
      priorityCeiling: '3',
      issueTypes: ['epic'],
      labels: ['marker-label'],
      filterText: 'marker-filter-text',
      hideDone: false,
      stalledOnly: true,
    });

    result.current.handleApplyBoardFilterPreset(preset);

    expect(vi.mocked(params.setView).mock.calls.at(-1)).toEqual(['digest']);
    expect(vi.mocked(params.setSelectedProjectIds).mock.calls.at(-1)).toEqual([
      ['proj-marker-a', 'proj-marker-b'],
    ]);
    expect(vi.mocked(params.setPriorityCeiling).mock.calls.at(-1)).toEqual(['3']);
    expect(vi.mocked(params.setIssueTypes).mock.calls.at(-1)).toEqual([['epic']]);
    expect(vi.mocked(params.setLabels).mock.calls.at(-1)).toEqual([['marker-label']]);
    expect(vi.mocked(params.setFilterText).mock.calls.at(-1)).toEqual(['marker-filter-text']);
    expect(vi.mocked(params.setHideDone).mock.calls.at(-1)).toEqual([false]);
    expect(vi.mocked(params.setStalledOnly).mock.calls.at(-1)).toEqual([true]);
  });

  it('re-subscribes handleApplyBoardFilterPreset to a new setter when the dependency array is pinned correctly', () => {
    // レビュー教訓(useAppKeyboardShortcuts): 依存配列から setter が漏れていると
    // rerender 後も古い setter (stale closure) を呼び続けてしまう。setFilterText
    // だけを差し替えて rerender し、新しい参照が呼ばれることを確認する。
    const params = baseParams();
    const { result, rerender } = renderHook(
      (p: AppFilterPresetsParams) => useAppFilterPresets(p),
      { initialProps: params },
    );

    const newSetFilterText = vi.fn();
    const nextParams = { ...params, setFilterText: newSetFilterText };
    rerender(nextParams);

    result.current.handleApplyBoardFilterPreset(makePreset({ filterText: 'after-rerender' }));

    expect(newSetFilterText).toHaveBeenCalledWith('after-rerender');
    expect(params.setFilterText).not.toHaveBeenCalled();
  });

  describe('default preset auto-apply effect', () => {
    it('applies the default preset once when this browser has no stored filter state', () => {
      const otherPreset = makePreset({ id: 'preset-other', view: 'split' });
      const defaultPreset = makePreset({
        id: 'preset-default',
        isDefault: true,
        view: 'digest',
        filterText: 'default-marker-text',
      });
      const params = baseParams({ boardFilterPresets: [otherPreset, defaultPreset] });

      renderHook(() => useAppFilterPresets(params));

      expect(vi.mocked(params.setView).mock.calls.at(-1)).toEqual(['digest']);
      expect(vi.mocked(params.setFilterText).mock.calls.at(-1)).toEqual(['default-marker-text']);
      expect(params.setView).toHaveBeenCalledTimes(1);
    });

    it('does not apply the default preset when this browser already has stored filter state', () => {
      localStorage.setItem(UI_STORAGE_KEYS.hideDone, JSON.stringify(true));
      const defaultPreset = makePreset({ id: 'preset-default', isDefault: true, view: 'digest' });
      const params = baseParams({ boardFilterPresets: [defaultPreset] });

      renderHook(() => useAppFilterPresets(params));

      expect(params.setView).not.toHaveBeenCalled();
    });

    it('does nothing when no preset is marked default', () => {
      const presets = [makePreset({ id: 'preset-a' }), makePreset({ id: 'preset-b' })];
      const params = baseParams({ boardFilterPresets: presets });

      renderHook(() => useAppFilterPresets(params));

      expect(params.setView).not.toHaveBeenCalled();
    });

    it('applies the default preset only once (ref guard), even if a default preset becomes available on a later rerender', () => {
      const params = baseParams({ boardFilterPresets: [] });
      const { rerender } = renderHook(
        (p: AppFilterPresetsParams) => useAppFilterPresets(p),
        { initialProps: params },
      );
      expect(params.setView).not.toHaveBeenCalled();

      const defaultPreset = makePreset({ id: 'preset-default', isDefault: true, view: 'digest' });
      rerender({ ...params, boardFilterPresets: [defaultPreset] });

      expect(params.setView).not.toHaveBeenCalled();
    });
  });
});
