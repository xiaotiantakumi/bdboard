/**
 * `.beads` の変更を検知した場合に stale にする queryKey の root。
 * チケット本文・コメントだけでなく、集計系ビュー、詳細パネルのタイムライン、
 * 着手中チケット同士のファイル重複も prefix マッチで一括 invalidate する
 * (サーバー側の短期メモ化があるため、再取得が即座に最新値を返すとは限らない)。
 */
export const BOARD_CHANGED_QUERY_KEY_ROOTS = [
  'board',
  'status',
  'ticket',
  'ticket-comments',
  'pending-decisions',
  'pr-links',
  'projects',
  'hygiene',
  'harness-drift',
  'project-harness',
  'harness-status-all',
  'lease-health',
  'merge-slot-status',
  'activity',
  'digest-activity',
  'cfd-stats',
  'dependency-graph',
  'ticket-timeline',
  'similar-tickets',
  'ticket-in-flight-overlaps',
] as const;

/**
 * queryKey root が board.changed の対象でない理由。新しい root は、この表か
 * BOARD_CHANGED_QUERY_KEY_ROOTS のどちらかへ必ず分類する。
 */
export const BOARD_CHANGED_QUERY_KEY_EXCLUSIONS = {
  'ticket-runs':
    'エージェント実行の履歴 (bdboard 自身の runStore 由来)。.beads の変更とは無関係に変わるので、実行を開始した側と終端を観測した側が invalidate する: 詳細パネル自身の実行開始時と追跡中の実行の終了時、Next Up ループの開始要求の結果が出た時と実行の終了時 (App が useNextUpRunLoopController に渡す通知)。別タブ・別端末など他のクライアントで始めた実行は、staleTime 経過後の再マウント・フォーカス時に反映される。',
  'agent-run':
    '履歴から選んだ 1 件の実行詳細で、bdboard 自身の実行記録 (runStore) 由来。.beads の変更では変わらず、実行中の進捗は詳細パネルの独自ポーリングで追う。',
  'agent-runs-active':
    '一括実行 (bdboard-xuuz) が「既に実行中のエージェントがあるカード」を対象外にするための board 全体の run 一覧で、ticket-runs/agent-run と同じく bdboard 自身の実行記録 (runStore) 由来。.beads の変更では変わらないので、ticket-runs と同じく実行を開始した側と終端を観測した側が invalidate する: 詳細パネル自身の実行開始時 (useAgentRunMutations.ts)、Next Up ループの開始要求の結果が出た時と実行の終了時 (ticketRunsInvalidator.ts、App が useNextUpRunLoopController に渡す通知)。別タブ・別端末など他のクライアントで始めた実行は、既定の staleTime (30秒) 経過後の再取得まで反映されない — 最終判定はサーバーの canStart / 409 already-running。',
  'agent-runs-config': '設定パネル自身の保存操作で invalidate する設定値。',
  'ai-quota-alert-config': '設定パネル自身の保存操作で invalidate する設定値。',
  'board-thresholds-config': '設定パネル自身の保存操作で invalidate する設定値。',
  'hygiene-thresholds-config': '設定パネル自身の保存操作で invalidate する設定値。',
  'scan-roots-config': '設定パネル自身の保存操作で invalidate する設定値。',
  'db-stats':
    '設定パネルのローカルキャッシュ DB 診断値 (サイズ・行数)。board.changed で行数は変わりうるが、パネルを開いた時点のスナップショットで足りるため追従させない。',
  sessions: 'session.changed が更新を通知するセッション一覧。',
  sessionHistory: 'セッション履歴であり、表示中は定期ポーリングする。',
  sessionTail: 'セッション出力であり、表示中は定期ポーリングする。',
  agentProcesses: 'ローカルのエージェントプロセス一覧であり、表示中は定期ポーリングする。',
  'chat-availability': 'チャット機能の利用可否は board データに依存しない。',
  'ai-quota': '外部 AI のクォータは独自の定期ポーリングで更新する。',
  tunnel: 'トンネル状態は board データに依存せず、開始中のみ独自にポーリングする。',
  'update-check': 'ソフトウェア更新確認は board データに依存しない。',
  'ticket-attachments':
    'チケット添付画像 (bdboard-qw26) は .beads とは別のファイルシステム保存で、bd の書き込みからは変化しない。アップロードはエージェントが curl で行う想定で UI 側に投稿操作が無いため、既定の staleTime (30秒) 経過後の再マウント・フォーカス時の自動再取得に任せる。',
  'throughput-stats':
    '/api/stats の集計は数秒〜十数秒かかる重い処理 (bdboard-ws2w で19秒を観測)。多数のエージェントが並行作業する夜間は board.changed が頻発するため、以前は統計タブを開いたままにするたびにこれが連続で走り、サーバーが CPU 100% に張り付いたまま戻らなくなっていた (bdboard-himp)。秒単位の鮮度を必要としない集計値なので board.changed では追従させず、staleTime を延長 (5分) して統計タブの再読み込みボタン、またはその延長した staleTime 経過後の再マウント・フォーカス時の自動再取得に任せる。',
  'model-stats':
    '/api/model-stats の集計も同様に重い処理 (bdboard-ws2w で12秒を観測)。理由は throughput-stats と同じ (bdboard-ws2w/bdboard-himp) で、board.changed では追従させず staleTime 延長 + 統計タブの再読み込みボタンに任せる。',
  'harness-kpi':
    'ハーネスKPI (reclaim・確認待ち滞留などの集計) も throughput-stats と同じ理由 (bdboard-ws2w/bdboard-himp) で重く、board.changed では追従させず staleTime 延長 + 統計タブの再読み込みボタンに任せる。',
} as const satisfies Readonly<Record<string, string>>;
