import { describe, expect, it } from 'vitest';
import {
  boardFilterPresetStatesEqual,
  findMatchingBoardFilterPreset,
  priorityCeilingValue,
  validateBoardFilterPresets,
  validateIssueTypeArray,
  validateLaneArray,
  validatePriorityCeiling,
  validateStatsWeeks,
  validateString,
  validateViewMode,
  type BoardFilterPreset,
  type BoardFilterPresetState,
} from './uiPersistedState';

describe('uiPersistedState', () => {
  it('accepts stats as a view mode', () => {
    expect(validateViewMode('stats')).toBe('stats');
  });

  it('accepts graph as a view mode', () => {
    expect(validateViewMode('graph')).toBe('graph');
  });

  it('accepts digest as a view mode', () => {
    expect(validateViewMode('digest')).toBe('digest');
  });

  it('accepts settings as a view mode', () => {
    expect(validateViewMode('settings')).toBe('settings');
  });

  it('accepts events as a view mode', () => {
    expect(validateViewMode('events')).toBe('events');
  });

  it('validates stats weeks options', () => {
    expect(validateStatsWeeks(4)).toBe(4);
    expect(validateStatsWeeks(8)).toBe(8);
    expect(validateStatsWeeks(12)).toBe(12);
    expect(validateStatsWeeks(6)).toBeNull();
  });

  it('validates priority ceiling choices', () => {
    expect(validatePriorityCeiling('all')).toBe('all');
    expect(validatePriorityCeiling('0')).toBe('0');
    expect(validatePriorityCeiling('4')).toBe('4');
    expect(validatePriorityCeiling(null)).toBeNull();
    expect(validatePriorityCeiling('5')).toBeNull();
    expect(validatePriorityCeiling(1)).toBeNull();
  });

  it('converts priority ceiling choice to numeric ceiling', () => {
    expect(priorityCeilingValue('all')).toBeNull();
    expect(priorityCeilingValue('0')).toBe(0);
    expect(priorityCeilingValue('2')).toBe(2);
    expect(priorityCeilingValue('4')).toBe(4);
  });

  it('validates issue type arrays', () => {
    expect(validateIssueTypeArray(['bug', 'task'])).toEqual(['bug', 'task']);
    expect(validateIssueTypeArray([])).toEqual([]);
    expect(validateIssueTypeArray(['bug', 'unknown'])).toBeNull();
    expect(validateIssueTypeArray('bug')).toBeNull();
    expect(validateIssueTypeArray([1, 2])).toBeNull();
  });

  it('validates lane arrays', () => {
    expect(validateLaneArray(['ready', 'done'])).toEqual(['ready', 'done']);
    expect(validateLaneArray([])).toEqual([]);
    expect(validateLaneArray(['ready', 'unknown'])).toBeNull();
    expect(validateLaneArray('ready')).toBeNull();
    expect(validateLaneArray([1, 2])).toBeNull();
  });

  it('validates string values', () => {
    expect(validateString('alpha')).toBe('alpha');
    expect(validateString('')).toBe('');
    expect(validateString(42)).toBeNull();
    expect(validateString(null)).toBeNull();
    expect(validateString(undefined)).toBeNull();
  });

  it('validates board filter presets', () => {
    const presets: BoardFilterPreset[] = [
      {
        id: 'preset-1',
        name: 'P1バグだけ',
        view: 'merged',
        selectedProjectIds: ['proj-1'],
        priorityCeiling: '1',
        issueTypes: ['bug'],
        labels: [],
        filterText: '',
      },
    ];
    expect(validateBoardFilterPresets(presets)).toEqual(presets);
    expect(validateBoardFilterPresets([{ ...presets[0], id: '' }])).toBeNull();
    expect(validateBoardFilterPresets([{ ...presets[0], view: 'invalid' }])).toBeNull();
    expect(validateBoardFilterPresets('bad')).toBeNull();
  });

  it('matches board filter preset state', () => {
    const state: BoardFilterPresetState = {
      view: 'next',
      selectedProjectIds: ['proj-1'],
      priorityCeiling: '1',
      issueTypes: ['bug', 'task'],
      labels: ['human'],
      filterText: 'alpha',
    };
    const presets: BoardFilterPreset[] = [
      {
        id: 'preset-1',
        name: 'Match',
        ...state,
      },
      {
        id: 'preset-2',
        name: 'Other',
        view: 'merged',
        selectedProjectIds: [],
        priorityCeiling: 'all',
        issueTypes: [],
        labels: [],
        filterText: '',
      },
    ];

    expect(boardFilterPresetStatesEqual(state, { ...state })).toBe(true);
    expect(
      boardFilterPresetStatesEqual(state, {
        ...state,
        issueTypes: ['task', 'bug'],
      }),
    ).toBe(true);
    expect(
      boardFilterPresetStatesEqual(state, {
        ...state,
        issueTypes: ['bug'],
      }),
    ).toBe(false);
    expect(
      boardFilterPresetStatesEqual(state, {
        ...state,
        labels: ['human'],
      }),
    ).toBe(true);
    expect(
      boardFilterPresetStatesEqual(state, {
        ...state,
        labels: [],
      }),
    ).toBe(false);
    expect(findMatchingBoardFilterPreset(presets, state)?.id).toBe('preset-1');
    expect(
      findMatchingBoardFilterPreset(presets, {
        ...state,
        filterText: 'beta',
      }),
    ).toBeNull();
  });
});
