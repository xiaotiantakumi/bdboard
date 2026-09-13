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
  'throughput-stats',
  'cfd-stats',
  'model-stats',
  'harness-kpi',
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
    'エージェント実行の履歴 (bdboard 自身の runStore 由来)。詳細パネル自身の実行開始時と、追跡中の実行が終わった時に invalidate する。他経路で始めた実行は再マウント・フォーカス時に反映される。',
  'agent-run':
    '履歴から選んだ 1 件の実行詳細で、bdboard 自身の実行記録 (runStore) 由来。.beads の変更では変わらず、実行中の進捗は詳細パネルの独自ポーリングで追う。',
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
} as const satisfies Readonly<Record<string, string>>;
