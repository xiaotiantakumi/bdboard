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
  'harness-drift',
  'project-harness',
  'harness-status-all',
  'ticket-timeline',
  'similar-tickets',
  'ticket-in-flight-overlaps',
] as const;

/**
 * queryKey root が board.changed の対象でない理由。新しい root は、この表か
 * BOARD_CHANGED_QUERY_KEY_ROOTS のどちらかへ必ず分類する。
 */
export const BOARD_CHANGED_QUERY_KEY_EXCLUSIONS = {
  'ai-quota-alert-config': '設定パネル自身の保存操作で invalidate する設定値。',
  'board-thresholds-config': '設定パネル自身の保存操作で invalidate する設定値。',
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
  'ticket-local-files':
    'チケット本文が指すプロジェクト内ファイルの一覧 (bdboard-vgdr)。本文やコメントの変更で候補は変わりうるが、取得のたびにサーバーが bd comments を起こすうえ board.changed は頻発するので追従させない。詳細パネルの開き直しか、既定の staleTime (30秒) 経過後の再マウント・フォーカス時の再取得に任せる。',
  'ticket-local-files-access-probe':
    'ローカルファイルのビューア画面がトンネルのガード (403) を判定するだけの探り (bdboard-teir)。ガードの可否は bd の書き込みでは変わらないので board.changed には追従させない。',
  'ticket-local-file-list':
    'プロジェクト内フォルダの中身 (bdboard-vgdr)。.beads の外のファイルシステムで、bd の書き込みからは変化しない。既定の staleTime 経過後の再マウント・フォーカス時の再取得に任せる。',
  'local-file-text':
    '別ウィンドウのビューアが表示する md/json/テキストの中身 (bdboard-vgdr)。.beads の外のファイルで bd の書き込みからは変化しない。ビューアの再読み込みか、既定の staleTime 経過後のフォーカス時の再取得に任せる。',
} as const satisfies Readonly<Record<string, string>>;
