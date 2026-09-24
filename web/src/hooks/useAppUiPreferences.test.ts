import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useAppUiPreferences } from './useAppUiPreferences';
import { DEFAULT_TIPS_BANNER_DISMISSED, DEFAULT_VIEW, UI_STORAGE_KEYS } from '../uiPersistedState';

describe('useAppUiPreferences', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('starts with the same defaults the 11 individual usePersistedState calls had in App.tsx', () => {
    const { result } = renderHook(() => useAppUiPreferences());

    expect(result.current.view).toBe(DEFAULT_VIEW);
    expect(result.current.selectedProjectIds).toEqual([]);
    expect(result.current.lastChatProjectId).toBe('');
    expect(result.current.boardFilterPresets).toEqual([]);
    expect(result.current.nextUpLimit).toBe(10);
    expect(result.current.nextUpShowEpics).toBe(false);
    expect(result.current.activityWindowDays).toBe(1);
    expect(result.current.digestWindowDays).toBe(1);
    expect(result.current.statsWeeks).toBe(8);
    expect(result.current.recentTickets).toEqual([]);
    expect(result.current.tipsBannerDismissed).toBe(DEFAULT_TIPS_BANNER_DISMISSED);
  });

  it('persists each field under its own UI_STORAGE_KEYS entry, unchanged from before bundling', () => {
    const { result } = renderHook(() => useAppUiPreferences());

    act(() => {
      result.current.setView('next');
      result.current.setView('split');
      result.current.setSelectedProjectIds(['proj-1']);
      result.current.setLastChatProjectId('proj-1');
      result.current.setBoardFilterPresets([
        {
          id: 'preset-1',
          name: 'My preset',
          view: 'split',
          selectedProjectIds: [],
          priorityCeiling: 'all',
          issueTypes: [],
          labels: [],
          filterText: '',
          hideDone: true,
          stalledOnly: false,
        },
      ]);
      result.current.setNextUpLimit(20);
      result.current.setNextUpShowEpics(true);
      result.current.setActivityWindowDays(7);
      result.current.setDigestWindowDays(3);
      result.current.setStatsWeeks(12);
      result.current.setRecentTickets([
        { id: 'bdboard-1', title: 'T', projectName: 'Project One' },
      ]);
      result.current.setTipsBannerDismissed(true);
    });

    expect(localStorage.getItem(UI_STORAGE_KEYS.view)).toBe(JSON.stringify('split'));
    expect(localStorage.getItem(UI_STORAGE_KEYS.selectedProjectIds)).toBe(
      JSON.stringify(['proj-1']),
    );
    expect(localStorage.getItem(UI_STORAGE_KEYS.lastChatProjectId)).toBe(
      JSON.stringify('proj-1'),
    );
    expect(localStorage.getItem(UI_STORAGE_KEYS.boardFilterPresets)).not.toBeNull();
    expect(localStorage.getItem(UI_STORAGE_KEYS.nextUpLimit)).toBe(JSON.stringify(20));
    expect(localStorage.getItem(UI_STORAGE_KEYS.nextUpShowEpics)).toBe(JSON.stringify(true));
    expect(localStorage.getItem(UI_STORAGE_KEYS.activityWindowDays)).toBe(JSON.stringify(7));
    expect(localStorage.getItem(UI_STORAGE_KEYS.digestWindowDays)).toBe(JSON.stringify(3));
    expect(localStorage.getItem(UI_STORAGE_KEYS.statsWeeks)).toBe(JSON.stringify(12));
    expect(localStorage.getItem(UI_STORAGE_KEYS.recentTickets)).not.toBeNull();
    expect(localStorage.getItem(UI_STORAGE_KEYS.tipsBannerDismissed)).toBe(JSON.stringify(true));
  });

  it('activityWindowDays and digestWindowDays are independent despite sharing a validator', () => {
    const { result } = renderHook(() => useAppUiPreferences());

    act(() => {
      result.current.setActivityWindowDays(7);
    });

    expect(result.current.activityWindowDays).toBe(7);
    expect(result.current.digestWindowDays).toBe(1);

    act(() => {
      result.current.setDigestWindowDays(3);
    });

    expect(result.current.activityWindowDays).toBe(7);
    expect(result.current.digestWindowDays).toBe(3);
  });

  it('restores previously persisted values on mount, per key', () => {
    localStorage.setItem(UI_STORAGE_KEYS.view, JSON.stringify('split'));
    localStorage.setItem(UI_STORAGE_KEYS.nextUpLimit, JSON.stringify(20));
    localStorage.setItem(UI_STORAGE_KEYS.tipsBannerDismissed, JSON.stringify(true));

    const { result } = renderHook(() => useAppUiPreferences());

    expect(result.current.view).toBe('split');
    expect(result.current.nextUpLimit).toBe(20);
    expect(result.current.tipsBannerDismissed).toBe(true);
    // Untouched keys still fall back to their documented defaults.
    expect(result.current.statsWeeks).toBe(8);
  });

  it('migrates a persisted merged view to split on mount', () => {
    localStorage.setItem(UI_STORAGE_KEYS.view, JSON.stringify('merged'));
    const { result } = renderHook(() => useAppUiPreferences());
    expect(result.current.view).toBe('split');
  });

  it('falls back to the default when a persisted value fails validation', () => {
    localStorage.setItem(UI_STORAGE_KEYS.view, JSON.stringify('not-a-view'));
    localStorage.setItem(UI_STORAGE_KEYS.nextUpLimit, JSON.stringify(-5));

    const { result } = renderHook(() => useAppUiPreferences());

    expect(result.current.view).toBe(DEFAULT_VIEW);
    expect(result.current.nextUpLimit).toBe(10);
  });
});
