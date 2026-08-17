/**
 * トンネル経由の書き込みを開放してよいかを、そのトンネルを起動した資格情報の
 * 強度だけから決める純粋関数(bdboard-9rz)。
 *
 * トンネル URL は公開されるので、書き込みが開いた瞬間にパスワードは
 * 「読まれて困る情報を守る鍵」から「他人のチケットを書き換えられる鍵」に変わる。
 * 一方で 5149cd4 は「短いパスワードでも起動できる」ことを意図して入れた緩和
 * (最小 2 文字)なので、短いパスワード自体は引き続き許可する。両者を両立させるため、
 * 「短いパスワードでは起動できるが書き込みは開かない(従来どおり localhost 限定に
 * フォールバックする)」という形にする。
 */

/** 自前生成のパスフレーズは常に十分なエントロピーを持つので長さ判定の対象外にする */
export type TunnelPasswordSource = 'generated' | 'user-supplied';

/**
 * 手入力パスワードで書き込みを開放するのに必要な最小長。
 * 文字数は UTF-16 コードユニットではなくコードポイントで数える
 * (絵文字や結合文字を含むパスワードを不当に短く/長く見積もらないため)。
 */
export const MIN_TUNNEL_WRITE_PASSWORD_LENGTH = 12;

export function passwordCodePointLength(password: string): number {
  return [...password].length;
}

export function passwordAllowsTunnelWrites(
  source: TunnelPasswordSource,
  password: string,
): boolean {
  if (source === 'generated') {
    return true;
  }
  return passwordCodePointLength(password) >= MIN_TUNNEL_WRITE_PASSWORD_LENGTH;
}
