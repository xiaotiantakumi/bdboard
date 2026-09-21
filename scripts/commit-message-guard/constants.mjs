// bdboard-sso1.46: commit-message-guard.mjs から move-only 分割。ガード全体で共有する定数
// (元ファイルの該当行をそのまま移動しただけで、値・コメントは変更していない)。

/** 理由付きで 1 回だけガードを外すためのエスケープハッチ。理由が空なら外れない。 */
export const OVERRIDE_ENV = 'BDBOARD_COMMIT_GUARD_OVERRIDE';

/** `-F <file>` で読み込むメッセージファイルの上限 (指摘 m6)。超えたら読まずに fail-open。 */
export const MAX_MESSAGE_FILE_BYTES = 1024 * 1024;
