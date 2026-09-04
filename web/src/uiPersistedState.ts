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

/*
  ビュー切替タブの並び順とラベルの単一原本。GlobalBar のタブ列と、プリセットの
  保存対象サマリ(describeBoardFilterPresetState)の両方がここを参照する。
*/
export const VIEW_ITEMS: readonly { view: ViewMode; label: string }[] = [
  { view: 'merged', label: '統合' },
  { view: 'split', label: '分割' },
  { view: 'next', label: 'Next Up' },
  { view: 'activity', label: 'アクティビティ' },
  { view: 'digest', label: 'ダイジェスト' },
  { view: 'stats', label: '統計' },
  { view: 'hygiene', label: '健全性' },
  { view: 'graph', label: '依存グラフ' },
  { view: 'events', label: 'イベント' },
  { view: 'settings', label: '設定' },
];

export function viewLabel(view: ViewMode): string {
  return VIEW_ITEMS.find((item) => item.view === view)?.label ?? view;
}

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
  nextUpShowEpics: 'bdboard.ui.nextUpShowEpics',
  activityWindowDays: 'bdboard.ui.activityWindowDays',
  digestWindowDays: 'bdboard.ui.digestWindowDays',
  statsWeeks: 'bdboard.ui.statsWeeks',
  boardPriorityCeiling: 'bdboard.ui.boardPriorityCeiling',
  boardIssueTypes: 'bdboard.ui.boardIssueTypes',
  boardLabels: 'bdboard.ui.boardLabels',
  boardFilterText: 'bdboard.ui.boardFilterText',
  boardFilterPresets: 'bdboard.ui.boardFilterPresets',
  chatModelSelections: 'bdboard.ui.chatModelSelections',
  chatPanelWidth: 'bdboard.ui.chatPanelWidth',
  ticketDetailPanelWidth: 'bdboard.ui.ticketDetailPanelWidth',
  sessionListPanelWidth: 'bdboard.ui.sessionListPanelWidth',
  sessionTailPanelWidth: 'bdboard.ui.sessionTailPanelWidth',
  notificationEvents: 'bdboard.ui.notificationEvents',
  notificationLastReadAt: 'bdboard.ui.notificationLastReadAt',
  notificationsEnabled: 'bdboard.ui.notificationsEnabled',
  watchedTicketIds: 'bdboard.ui.watchedTicketIds',
  recentTickets: 'bdboard.ui.recentTickets',
  /*
   * bdboard-h4xs.17: Tips バナー(TipsBanner)を閉じた状態の永続化。
   * 保存先は localStorage、キーは 'bdboard.ui.tipsBannerDismissed'。
   * 未設定/読み取り失敗時は false (=表示する) にフォールバックする
   * (usePersistedState の既定値挙動)。再表示したい場合はヘッダー右上の
   * 「⋯」(その他のメニュー) から「Tips バナーを表示」を選ぶ
   * (OverflowMenu.tsx / App.tsx 参照)。
   */
  tipsBannerDismissed: 'bdboard.ui.tipsBannerDismissed',
} as const;

export const RECENT_TICKETS_MAX = 10;

export interface RecentTicketEntry {
  id: string;
  title: string;
  projectName: string;
}

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

export function validateWatchedTicketIds(value: unknown): string[] | null {
  const ids = validateStringArray(value);
  if (ids === null) {
    return null;
  }
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const id of ids) {
    const trimmed = id.trim();
    if (trimmed === '' || seen.has(trimmed)) {
      return null;
    }
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized;
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

export const DEFAULT_HIDE_DONE = true;
export const DEFAULT_STALLED_ONLY = false;
export const DEFAULT_TIPS_BANNER_DISMISSED = false;

export interface BoardFilterPreset {
  id: string;
  name: string;
  view: ViewMode;
  selectedProjectIds: string[];
  priorityCeiling: PriorityCeilingChoice;
  issueTypes: string[];
  labels: string[];
  filterText: string;
  hideDone: boolean;
  stalledOnly: boolean;
  /*
    「既定にする」で選ばれたプリセット。保存済みの絞り込み状態がまだ1つも無い
    ブラウザ(= 初回起動)でだけ自動適用される。既に自分の絞り込みを持っている
    利用者の状態を勝手に上書きしないため、それ以外の場面では適用しない。
  */
  isDefault?: boolean;
}

export interface BoardFilterPresetState {
  view: ViewMode;
  selectedProjectIds: string[];
  priorityCeiling: PriorityCeilingChoice;
  issueTypes: string[];
  labels: string[];
  filterText: string;
  hideDone: boolean;
  stalledOnly: boolean;
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
  let hideDone: boolean;
  if (record.hideDone === undefined) {
    hideDone = DEFAULT_HIDE_DONE;
  } else {
    const validatedHideDone = validateBoolean(record.hideDone);
    if (validatedHideDone === null) {
      return null;
    }
    hideDone = validatedHideDone;
  }
  let stalledOnly: boolean;
  if (record.stalledOnly === undefined) {
    stalledOnly = DEFAULT_STALLED_ONLY;
  } else {
    const validatedStalledOnly = validateBoolean(record.stalledOnly);
    if (validatedStalledOnly === null) {
      return null;
    }
    stalledOnly = validatedStalledOnly;
  }
  const preset: BoardFilterPreset = {
    id: record.id,
    name,
    view,
    selectedProjectIds,
    priorityCeiling,
    issueTypes,
    labels,
    filterText,
    hideDone,
    stalledOnly,
  };
  // 既存の保存データには isDefault が無いので、true のときだけ持たせる(欠損は false 扱い)。
  if (record.isDefault === true) {
    preset.isDefault = true;
  }
  return preset;
}

function validateRecentTicketEntry(value: unknown): RecentTicketEntry | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.id !== 'string' || record.id.trim() === '') {
    return null;
  }
  if (typeof record.title !== 'string') {
    return null;
  }
  if (typeof record.projectName !== 'string') {
    return null;
  }
  return {
    id: record.id,
    title: record.title,
    projectName: record.projectName,
  };
}

export function validateRecentTickets(value: unknown): RecentTicketEntry[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const entries: RecentTicketEntry[] = [];
  for (const item of value) {
    const entry = validateRecentTicketEntry(item);
    if (entry === null) {
      return null;
    }
    entries.push(entry);
  }
  return entries;
}

export function recordRecentTicket(
  current: RecentTicketEntry[],
  entry: RecentTicketEntry,
): RecentTicketEntry[] {
  const withoutDuplicate = current.filter((ticket) => ticket.id !== entry.id);
  const next = [entry, ...withoutDuplicate];
  return next.slice(0, RECENT_TICKETS_MAX);
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
    left.hideDone === right.hideDone &&
    left.stalledOnly === right.stalledOnly &&
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

/**
 * プリセットが復元する絞り込み状態が、このブラウザに1つでも保存済みかどうか。
 * 「既定」プリセットは、これが false のとき(= 実質的な初回起動)だけ自動適用する。
 */
export function hasStoredBoardFilterState(storage?: Pick<Storage, 'getItem'>): boolean {
  const keys = [
    UI_STORAGE_KEYS.view,
    UI_STORAGE_KEYS.selectedProjectIds,
    UI_STORAGE_KEYS.boardPriorityCeiling,
    UI_STORAGE_KEYS.boardIssueTypes,
    UI_STORAGE_KEYS.boardLabels,
    UI_STORAGE_KEYS.boardFilterText,
    UI_STORAGE_KEYS.hideDone,
    UI_STORAGE_KEYS.stalledOnly,
  ];
  try {
    const target = storage ?? (typeof localStorage === 'undefined' ? null : localStorage);
    if (target === null) {
      return true; // 判定できないときは「保存済み」に倒して自動適用しない。
    }
    return keys.some((key) => target.getItem(key) !== null);
  } catch {
    return true;
  }
}

export function findDefaultBoardFilterPreset(
  presets: readonly BoardFilterPreset[],
): BoardFilterPreset | null {
  return presets.find((preset) => preset.isDefault === true) ?? null;
}

/**
 * プリセットの保存対象を1行で説明する。「現在の状態を保存」とだけ書いてあると何が
 * 保存されるのか分からない、というのが Turn 4 の出発点なので、実際に
 * BoardFilterPresetState が持っているものだけを、持っている粒度でそのまま並べる。
 */
export function describeBoardFilterPresetState(state: BoardFilterPresetState): string {
  const parts: string[] = [`ビュー: ${viewLabel(state.view)}`];

  parts.push(
    state.selectedProjectIds.length > 0
      ? `プロジェクト${state.selectedProjectIds.length}件`
      : '全プロジェクト',
  );

  if (state.priorityCeiling !== 'all') {
    parts.push(`P${state.priorityCeiling}以上`);
  }
  if (state.issueTypes.length > 0) {
    parts.push(`種別${state.issueTypes.length}件`);
  }
  if (state.labels.length > 0) {
    parts.push(`ラベル${state.labels.length}件`);
  }
  if (state.stalledOnly) {
    parts.push('滞留のみ');
  }
  if (!state.hideDone) {
    parts.push('完了も表示');
  }
  const filterText = state.filterText.trim();
  if (filterText !== '') {
    parts.push(`検索「${filterText}」`);
  }

  return parts.join(' / ');
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
  // 取り除くものが無いときは同じ参照を返す。呼び出し側(usePersistedState)が
  // 「変わっていないなら書かない」で判定できるようにするため。
  return filtered.length === selectedIds.length ? selectedIds : filtered;
}
