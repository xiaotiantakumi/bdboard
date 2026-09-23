import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useBoardFilterState } from './useBoardFilterState';
import { UI_STORAGE_KEYS } from '../uiPersistedState';

describe('useBoardFilterState', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('starts with the documented defaults', () => {
    const { result } = renderHook(() => useBoardFilterState());

    expect(result.current.priorityCeiling).toBe('all');
    expect(result.current.issueTypes).toEqual([]);
    expect(result.current.labels).toEqual([]);
    expect(result.current.filterText).toBe('');
    expect(result.current.hideDone).toBe(true);
    expect(result.current.stalledOnly).toBe(false);
    expect(result.current.collapsedLanes).toEqual([]);
    expect(result.current.collapsedLanesSet.size).toBe(0);
    expect(result.current.filter).toEqual({
      priorityCeiling: null,
      issueTypes: [],
      labels: [],
      text: '',
    });
  });

  it('derives filter.priorityCeiling from the persisted choice via priorityCeilingValue', () => {
    const { result } = renderHook(() => useBoardFilterState());

    act(() => {
      result.current.setPriorityCeiling('2');
    });

    expect(result.current.priorityCeiling).toBe('2');
    expect(result.current.filter.priorityCeiling).toBe(2);

    act(() => {
      result.current.setPriorityCeiling('all');
    });

    expect(result.current.filter.priorityCeiling).toBeNull();
  });

  it('keeps filter.issueTypes/labels/text in sync with their setters', () => {
    const { result } = renderHook(() => useBoardFilterState());

    act(() => {
      result.current.setIssueTypes(['bug', 'task']);
      result.current.setLabels(['frontend']);
      result.current.setFilterText('reconnect');
    });

    expect(result.current.filter).toEqual({
      priorityCeiling: null,
      issueTypes: ['bug', 'task'],
      labels: ['frontend'],
      text: 'reconnect',
    });
  });

  it('toggles hideDone and stalledOnly independently', () => {
    const { result } = renderHook(() => useBoardFilterState());

    act(() => {
      result.current.setHideDone(false);
    });
    expect(result.current.hideDone).toBe(false);
    expect(result.current.stalledOnly).toBe(false);

    act(() => {
      result.current.setStalledOnly(true);
    });
    expect(result.current.hideDone).toBe(false);
    expect(result.current.stalledOnly).toBe(true);
  });

  it('onToggleLaneCollapse adds and removes a lane from collapsedLanesSet', () => {
    const { result } = renderHook(() => useBoardFilterState());

    act(() => {
      result.current.onToggleLaneCollapse('done');
    });
    expect(result.current.collapsedLanes).toEqual(['done']);
    expect(result.current.collapsedLanesSet.has('done')).toBe(true);

    act(() => {
      result.current.onToggleLaneCollapse('blocked');
    });
    expect(result.current.collapsedLanes).toEqual(['done', 'blocked']);

    act(() => {
      result.current.onToggleLaneCollapse('done');
    });
    expect(result.current.collapsedLanes).toEqual(['blocked']);
    expect(result.current.collapsedLanesSet.has('done')).toBe(false);
  });

  it('persists each piece of state under its own UI_STORAGE_KEYS entry', () => {
    const { result } = renderHook(() => useBoardFilterState());

    act(() => {
      result.current.setPriorityCeiling('1');
      result.current.setIssueTypes(['bug']);
      result.current.setLabels(['ui']);
      result.current.setFilterText('hello');
      result.current.setHideDone(false);
      result.current.setStalledOnly(true);
      result.current.onToggleLaneCollapse('ready');
    });

    expect(localStorage.getItem(UI_STORAGE_KEYS.boardPriorityCeiling)).toBe(
      JSON.stringify('1'),
    );
    expect(localStorage.getItem(UI_STORAGE_KEYS.boardIssueTypes)).toBe(
      JSON.stringify(['bug']),
    );
    expect(localStorage.getItem(UI_STORAGE_KEYS.boardLabels)).toBe(
      JSON.stringify(['ui']),
    );
    expect(localStorage.getItem(UI_STORAGE_KEYS.boardFilterText)).toBe(
      JSON.stringify('hello'),
    );
    expect(localStorage.getItem(UI_STORAGE_KEYS.hideDone)).toBe(JSON.stringify(false));
    expect(localStorage.getItem(UI_STORAGE_KEYS.stalledOnly)).toBe(JSON.stringify(true));
    expect(localStorage.getItem(UI_STORAGE_KEYS.collapsedLanes)).toBe(
      JSON.stringify(['ready']),
    );
  });

  it('restores previously persisted state on mount', () => {
    localStorage.setItem(UI_STORAGE_KEYS.boardPriorityCeiling, JSON.stringify('3'));
    localStorage.setItem(UI_STORAGE_KEYS.hideDone, JSON.stringify(false));
    localStorage.setItem(UI_STORAGE_KEYS.collapsedLanes, JSON.stringify(['awaiting_human']));

    const { result } = renderHook(() => useBoardFilterState());

    expect(result.current.priorityCeiling).toBe('3');
    expect(result.current.filter.priorityCeiling).toBe(3);
    expect(result.current.hideDone).toBe(false);
    expect(result.current.collapsedLanesSet.has('awaiting_human')).toBe(true);
  });
});
