import { LANES, type BoardMode, type Lane } from './api';

export type ViewMode =
  | 'merged'
  | 'split'
  | 'next'
  | 'activity'
  | 'digest'
  | 'stats'
  | 'graph'
  | 'hygiene'
  | 'events'
  | 'settings';

export const DEFAULT_VIEW: ViewMode = 'merged';

export const NEXT_UP_LIMITS = [5, 10, 20] as const;
export type NextUpLimit = (typeof NEXT_UP_LIMITS)[number];

export const ACTIVITY_WINDOW_DAYS = [1, 3, 7] as const;
export type ActivityWindowDays = (typeof ACTIVITY_WINDOW_DAYS)[number];

export const STATS_WEEKS = [4, 8, 12] as const;
export type StatsWeeks = (typeof STATS_WEEKS)[number];

export const UI_STORAGE_KEYS = {
  view: 'bdboard.ui.view',
  lastChatProjectId: 'bdboard.ui.lastChatProjectId',
  selectedProjectIds: 'bdboard.ui.selectedProjectIds',
  hideDone: 'bdboard.ui.hideDone',
  collapsedLanes: 'bdboard.ui.collapsedLanes',
  stalledOnly: 'bdboard.ui.stalledOnly',
  nextUpLimit: 'bdboard.ui.nextUpLimit',
  activityWindowDays: 'bdboard.ui.activityWindowDays',
  digestWindowDays: 'bdboard.ui.digestWindowDays',
  statsWeeks: 'bdboard.ui.statsWeeks',
  boardPriorityCeiling: 'bdboard.ui.boardPriorityCeiling',
  boardIssueTypes: 'bdboard.ui.boardIssueTypes',
  boardLabels: 'bdboard.ui.boardLabels',
  boardFilterText: 'bdboard.ui.boardFilterText',
  boardFilterPresets: 'bdboard.ui.boardFilterPresets',
  chatModelSelections: 'bdboard.ui.chatModelSelections',
  notificationEvents: 'bdboard.ui.notificationEvents',
  notificationLastReadAt: 'bdboard.ui.notificationLastReadAt',
  notificationsEnabled: 'bdboard.ui.notificationsEnabled',
} as const;

export const BOARD_ISSUE_TYPES = ['bug', 'feature', 'task', 'chore', 'epic'] as const;

export type PriorityCeilingChoice = 'all' | '0' | '1' | '2' | '3' | '4';

export function validatePriorityCeiling(value: unknown): PriorityCeilingChoice | null {
  if (
    value === 'all' ||
    value === '0' ||
    value === '1' ||
    value === '2' ||
    value === '3' ||
    value === '4'
  ) {
    return value;
  }
  return null;
}

export function priorityCeilingValue(choice: PriorityCeilingChoice): number | null {
  if (choice === 'all') {
    return null;
  }
  return Number(choice);
}

export function validateIssueTypeArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  if (!value.every((item) => typeof item === 'string')) {
    return null;
  }
  const allowed = new Set<string>(BOARD_ISSUE_TYPES);
  if (!value.every((item) => allowed.has(item))) {
    return null;
  }
  return value;
}

export function validateLaneArray(value: unknown): Lane[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  if (!value.every((item) => typeof item === 'string')) {
    return null;
  }
  const allowed = new Set<string>(LANES);
  if (!value.every((item) => allowed.has(item))) {
    return null;
  }
  return value as Lane[];
}


export function validateBoardMode(value: unknown): BoardMode | null {
  if (value === 'merged' || value === 'split') {
    return value;
  }
  return null;
}

export function validateViewMode(value: unknown): ViewMode | null {
  if (
    value === 'merged' ||
    value === 'split' ||
    value === 'next' ||
    value === 'activity' ||
    value === 'digest' ||
    value === 'stats' ||
    value === 'graph' ||
    value === 'hygiene' ||
    value === 'events' ||
    value === 'settings'
  ) {
    return value;
  }
  return null;
}

export function boardApiModeFromView(view: ViewMode): BoardMode {
  return view === 'split' ? 'split' : 'merged';
}

export function validateNextUpLimit(value: unknown): NextUpLimit | null {
  if (value === 5 || value === 10 || value === 20) {
    return value;
  }
  return null;
}

export function validateActivityWindowDays(value: unknown): ActivityWindowDays | null {
  if (value === 1 || value === 3 || value === 7) {
    return value;
  }
  return null;
}

export function validateStatsWeeks(value: unknown): StatsWeeks | null {
  if (value === 4 || value === 8 || value === 12) {
    return value;
  }
  return null;
}

export function activityWindowLabel(days: ActivityWindowDays): string {
  switch (days) {
    case 1:
      return '24時間';
    case 3:
      return '3日';
    case 7:
      return '7日';
  }
}

export function statsWeeksLabel(weeks: StatsWeeks): string {
  switch (weeks) {
    case 4:
      return '4週';
    case 8:
      return '8週';
    case 12:
      return '12週';
  }
}

export function validateStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  if (!value.every((item) => typeof item === 'string')) {
    return null;
  }
  return value;
}

export function validateChatModelSelections(
  value: unknown,
): Record<string, Record<string, string>> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const entries = Object.entries(value);
  if (
    !entries.every(([projectId, agentMap]) => {
      if (typeof projectId !== 'string') {
        return false;
      }
      if (agentMap === null || typeof agentMap !== 'object' || Array.isArray(agentMap)) {
        return false;
      }
      return Object.entries(agentMap).every(
        ([agentId, modelId]) => typeof agentId === 'string' && typeof modelId === 'string',
      );
    })
  ) {
    return null;
  }
  return value as Record<string, Record<string, string>>;
}

export function validateBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') {
    return value;
  }
  return null;
}

export function validateString(value: unknown): string | null {
  if (typeof value === 'string') {
    return value;
  }
  return null;
}

export const BOARD_FILTER_PRESET_NAME_MAX_LENGTH = 40;

export interface BoardFilterPreset {
  id: string;
  name: string;
  view: ViewMode;
  selectedProjectIds: string[];
  priorityCeiling: PriorityCeilingChoice;
  issueTypes: string[];
  labels: string[];
  filterText: string;
}

export interface BoardFilterPresetState {
  view: ViewMode;
  selectedProjectIds: string[];
  priorityCeiling: PriorityCeilingChoice;
  issueTypes: string[];
  labels: string[];
  filterText: string;
}

function validateBoardFilterPreset(value: unknown): BoardFilterPreset | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.id !== 'string' || record.id.trim() === '') {
    return null;
  }
  if (typeof record.name !== 'string') {
    return null;
  }
  const name = record.name.trim();
  if (name === '' || name.length > BOARD_FILTER_PRESET_NAME_MAX_LENGTH) {
    return null;
  }
  const view = validateViewMode(record.view);
  if (view === null) {
    return null;
  }
  const selectedProjectIds = validateStringArray(record.selectedProjectIds);
  if (selectedProjectIds === null) {
    return null;
  }
  const priorityCeiling = validatePriorityCeiling(record.priorityCeiling);
  if (priorityCeiling === null) {
    return null;
  }
  const issueTypes = validateIssueTypeArray(record.issueTypes);
  if (issueTypes === null) {
    return null;
  }
  const labels = validateStringArray(record.labels);
  if (labels === null) {
    return null;
  }
  const filterText = validateString(record.filterText);
  if (filterText === null) {
    return null;
  }
  return {
    id: record.id,
    name,
    view,
    selectedProjectIds,
    priorityCeiling,
    issueTypes,
    labels,
    filterText,
  };
}

export function validateBoardFilterPresets(value: unknown): BoardFilterPreset[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const presets: BoardFilterPreset[] = [];
  const seenIds = new Set<string>();
  for (const item of value) {
    const preset = validateBoardFilterPreset(item);
    if (preset === null || seenIds.has(preset.id)) {
      return null;
    }
    seenIds.add(preset.id);
    presets.push(preset);
  }
  return presets;
}

export function createBoardFilterPresetId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `preset-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function stringArraysEqualUnordered(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  const rightCounts = new Map<string, number>();
  for (const value of right) {
    rightCounts.set(value, (rightCounts.get(value) ?? 0) + 1);
  }
  for (const value of left) {
    const count = rightCounts.get(value);
    if (count === undefined || count === 0) {
      return false;
    }
    if (count === 1) {
      rightCounts.delete(value);
    } else {
      rightCounts.set(value, count - 1);
    }
  }
  return rightCounts.size === 0;
}

export function boardFilterPresetStatesEqual(
  left: BoardFilterPresetState,
  right: BoardFilterPresetState,
): boolean {
  return (
    left.view === right.view &&
    left.priorityCeiling === right.priorityCeiling &&
    left.filterText === right.filterText &&
    stringArraysEqualUnordered(left.issueTypes, right.issueTypes) &&
    stringArraysEqualUnordered(left.labels, right.labels) &&
    stringArraysEqualUnordered(left.selectedProjectIds, right.selectedProjectIds)
  );
}

export function findMatchingBoardFilterPreset(
  presets: readonly BoardFilterPreset[],
  state: BoardFilterPresetState,
): BoardFilterPreset | null {
  return presets.find((preset) => boardFilterPresetStatesEqual(preset, state)) ?? null;
}

export function sanitizeProjectFilter(
  selectedIds: string[],
  availableProjectIds: readonly string[],
): string[] {
  if (selectedIds.length === 0) {
    return selectedIds;
  }
  if (availableProjectIds.length === 0) {
    return [];
  }
  const validIds = new Set(availableProjectIds);
  const filtered = selectedIds.filter((id) => validIds.has(id));
  if (filtered.length === 0) {
    return [];
  }
  return filtered;
}
