// bdboard-sso1.5: TicketDetailPanel.tsx から純粋な定数を移動しただけのファイル。
// 挙動は一切変えていない。
export const DEPENDENCY_SEARCH_DEBOUNCE_MS = 200;
export const DEPENDENCY_SEARCH_LIMIT = 20;

/**
 * 「衝突しうる着手中チケット」で相手 1 件あたりに並べるファイル数の上限。
 * 大きく育ったブランチだと 100 件を超えることがあり、詳細パネルがファイル一覧で
 * 埋まって他の情報が押し出される。残りは件数だけ出す。
 */
export const OVERLAP_FILE_DISPLAY_LIMIT = 20;

export const COPY_FEEDBACK_MS = 2000;
