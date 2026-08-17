export const CHAT_MESSAGE_MAX_LENGTH = 4000;

/** プロジェクトごとに記憶しておく既知チャットセッションIDの上限件数 (超過分は古い順に忘れる)。 */
export const CHAT_SESSION_MAX_PER_PROJECT = 20;

/**
 * セッションあたりのチャットメッセージ保持上限 (超過分は古い順に削除)。
 * プロジェクトあたりのセッション数は CHAT_SESSION_MAX_PER_PROJECT(20) で
 * ローテーションされ、孤児行はリポジトリ起動時スイープで除去されるため、
 * 最悪 CHAT_SESSION_MAX_PER_PROJECT × 本上限 × CHAT_MESSAGE_MAX_LENGTH(4000)
 * (~16MB/プロジェクト) が実効上限 — interactions テーブル(5000件グローバル)と
 * 同程度のローカル SQLite 容量として許容する。
 */
export const CHAT_MESSAGES_MAX_PER_SESSION = 200;

/**
 * assistant メッセージに永続化する failedTools の上限 (重複除去後)。
 * permission denial は失敗ツール呼び出し1回ごとに1エントリ生むため、
 * 上限なしだと同名ツールの連打で failed_tools カラム (JSON 配列 TEXT) が
 * 無制限に膨らむ。上記 ~16MB/プロジェクト試算は本文 (CHAT_MESSAGE_MAX_LENGTH)
 * のみの見積もりなので、この列は小さな固定上限で抑える。
 */
export const CHAT_FAILED_TOOLS_MAX = 20;

export const CHAT_SESSION_ID_MAX_LENGTH = 200;

/**
 * 発見される既存セッション一覧の最大件数。
 *
 * 適用順序が重要(bdboard-3tw.104.3 レビュー M2): mtime 降順で「所有権(cwd)を検証できた」
 * セッションに対して適用する。検証前の候補(ディレクトリ名だけで拾った時点のもの)に
 * 適用すると、cwd 不一致で除外される worktree 由来セッション等が新しい順に枠を埋めてしまい、
 * 本チェックアウトの有効なセッションが一覧から押し出されうる。
 */
export const DISCOVERED_CHAT_SESSIONS_MAX = 50;
/** discovered session のメッセージプレビューの最大文字数。 */
export const DISCOVERED_SESSION_PREVIEW_MAX_CHARS = 200;
/**
 * adopt 直後のチャット履歴シード(bdboard-3tw.104.3 レビュー M1)に含める、
 * トランスクリプト末尾のメッセージ数の上限。
 */
export const ADOPT_SEED_MESSAGE_LIMIT = 20;

export const BD_TICKET_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const CONTROL_CHAR_PATTERN = /[\u0000-\u001f\u007f]/;

export function isSafeCliArgument(value: string): boolean {
  if (value.length === 0) {
    return false;
  }

  if (value.startsWith('-')) {
    return false;
  }

  if (CONTROL_CHAR_PATTERN.test(value)) {
    return false;
  }

  if (value.includes('\n') || value.includes('\r')) {
    return false;
  }

  return true;
}

/**
 * チャットセッションIDの妥当性。CLI アダプタごとに形式が違う（claude は UUID だが
 * 他ツールはそうとは限らない）ので形式は問わず、「不透明・印字可能・200字以内・
 * 制御文字/改行なし・CLI 引数として安全」だけを要求する。
 */
export function isValidChatSessionId(value: string): boolean {
  if (value.length > CHAT_SESSION_ID_MAX_LENGTH) {
    return false;
  }
  return isSafeCliArgument(value);
}

export function isValidBdTicketId(value: string): boolean {
  if (value.length > 200) {
    return false;
  }

  if (!isSafeCliArgument(value)) {
    return false;
  }

  return BD_TICKET_ID_PATTERN.test(value);
}
