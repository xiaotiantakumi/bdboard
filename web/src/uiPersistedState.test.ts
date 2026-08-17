import { describe, expect, it } from 'vitest';
import {
  priorityCeilingValue,
  validateIssueTypeArray,
  validatePriorityCeiling,
  validateStatsWeeks,
  validateString,
  validateViewMode,
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

  it('validates string values', () => {
    expect(validateString('alpha')).toBe('alpha');
    expect(validateString('')).toBe('');
    expect(validateString(42)).toBeNull();
    expect(validateString(null)).toBeNull();
    expect(validateString(undefined)).toBeNull();
  });
});
