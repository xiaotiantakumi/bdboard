// bdboard-sso1.26: web/src/uiPersistedState.ts から move-only で分割。
// 挙動・型は変えていない (移動のみ)。

export const UI_STORAGE_KEYS = {
  view: 'bdboard.ui.view',
  lastChatProjectId: 'bdboard.ui.lastChatProjectId',
  selectedProjectIds: 'bdboard.ui.selectedProjectIds',
  hideDone: 'bdboard.ui.hideDone',
  collapsedLanes: 'bdboard.ui.collapsedLanes',
  stalledOnly: 'bdboard.ui.stalledOnly',
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
  /*
   * bdboard-3tw.161: 最後に受け取った通知の SSE event id。usePersistedState は通さず生文字列で
   * 保存する (web/src/lib/notificationLastEventId.ts)。
   */
  notificationLastEventId: 'bdboard.ui.notificationLastEventId',
  watchedTicketIds: 'bdboard.ui.watchedTicketIds',
  recentTickets: 'bdboard.ui.recentTickets',
  /*
   * bdboard-h4xs.17: Tips バナー(TipsBanner)を閉じた状態の永続化。
   * 保存先は localStorage、キーは 'bdboard.ui.tipsBannerDismissed'。
   * 未設定/読み取り失敗時は false (=表示する) にフォールバックする
   * (usePersistedState の既定値挙動)。再表示したい場合はヘッダー右上の
   * 「⋯」(その他のメニュー) から「Tips バナーを表示」を選ぶ
   * (OverflowMenu.tsx / App.tsx 参照)。
   *
   * 注意 (UI_STORAGE_KEYS 全体に共通する制約): localStorage は origin 単位なので、
   * cloudflared の quick tunnel 経由でスマホから見る場合、トンネルを張り直すたびに
   * サブドメインが変わり = 別 origin になり、閉じた状態はリセットされる。
   * サーバー再起動のたびにトンネルも張り直しになるため、スマホでは「閉じたのに
   * また出た」が起こりうる。これは本キー固有の不具合ではなく永続化方式の性質。
   */
  tipsBannerDismissed: 'bdboard.ui.tipsBannerDismissed',
} as const;

export const DEFAULT_TIPS_BANNER_DISMISSED = false;
