import type { ViewMode } from './uiPersistedState';

export interface PaletteAction {
  id: string;
  label: string;
  /** Space-separated tokens matched against the query (label is always included). */
  keywords: string;
  group: string;
  detail?: string;
  onSelect: () => void;
}

const VIEW_LABELS: Record<ViewMode, string> = {
  merged: '統合',
  split: '分割',
  next: 'Next Up',
  activity: 'アクティビティ',
  digest: 'ダイジェスト',
  stats: '統計',
  hygiene: '健全性',
  graph: '依存グラフ',
  events: 'イベント',
  settings: '設定',
};

function normalizeForMatch(text: string): string {
  return text.trim().toLowerCase();
}

function actionHaystack(action: PaletteAction): string {
  return normalizeForMatch(`${action.label} ${action.keywords} ${action.group}`);
}

export function filterPaletteActions(
  actions: PaletteAction[],
  query: string,
): PaletteAction[] {
  const normalizedQuery = normalizeForMatch(query);
  if (normalizedQuery.length === 0) {
    return actions;
  }

  return actions.filter((action) => actionHaystack(action).includes(normalizedQuery));
}

export interface BuildPaletteActionsInput {
  onViewChange: (view: ViewMode) => void;
  onOpenChat: () => void;
  onToggleHideDone: () => void;
  hideDone: boolean;
  onToggleStalledOnly: () => void;
  stalledOnly: boolean;
  onOpenSessionList: () => void;
  onRefresh: () => void;
  chatAvailable: boolean;
}

export function buildPaletteActions(
  input: BuildPaletteActionsInput,
): PaletteAction[] {
  const viewActions: PaletteAction[] = (Object.keys(VIEW_LABELS) as ViewMode[]).map(
    (view) => ({
      id: `view:${view}`,
      label: `ビュー: ${VIEW_LABELS[view]}`,
      keywords: `view ${view} ビュー ${VIEW_LABELS[view]}`,
      group: 'ビュー',
      onSelect: () => input.onViewChange(view),
    }),
  );

  const panelActions: PaletteAction[] = [
    ...(input.chatAvailable
      ? [
          {
            id: 'panel:chat',
            label: 'チャットを開く',
            keywords: 'chat チャット ai',
            group: 'パネル',
            onSelect: input.onOpenChat,
          } satisfies PaletteAction,
        ]
      : []),
    {
      id: 'panel:sessions',
      label: 'セッション一覧を開く',
      keywords: 'session セッション 一覧',
      group: 'パネル',
      onSelect: input.onOpenSessionList,
    },
    {
      id: 'view:settings',
      label: '設定を開く',
      keywords: 'settings 設定 preferences',
      group: 'パネル',
      onSelect: () => input.onViewChange('settings'),
    },
  ];

  const boardActions: PaletteAction[] = [
    {
      id: 'board:toggle-hide-done',
      label: 'doneレーン表示切替',
      keywords: 'done レーン 表示 隠す toggle',
      group: 'ボード',
      detail: input.hideDone ? '現在: 隠す' : '現在: 表示',
      onSelect: input.onToggleHideDone,
    },
    {
      id: 'board:toggle-stalled-only',
      label: '滞留のみ表示切替',
      keywords: 'stalled 滞留 フィルタ toggle',
      group: 'ボード',
      detail: input.stalledOnly ? '現在: オン' : '現在: オフ',
      onSelect: input.onToggleStalledOnly,
    },
  ];

  const otherActions: PaletteAction[] = [
    {
      id: 'other:refresh',
      label: '手動更新',
      keywords: 'refresh 更新 reload',
      group: 'その他',
      onSelect: input.onRefresh,
    },
  ];

  // View actions first (most common), then panels, board toggles, misc.
  // settings appears both as a view row and "設定を開く" — dedupe by keeping
  // the dedicated panel label (clearer intent) and dropping the view:* settings row.
  const viewActionsWithoutSettings = viewActions.filter(
    (action) => action.id !== 'view:settings',
  );

  return [
    ...viewActionsWithoutSettings,
    ...panelActions,
    ...boardActions,
    ...otherActions,
  ];
}
