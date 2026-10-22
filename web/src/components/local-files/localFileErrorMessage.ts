import { ApiError } from '../../api/http';

/**
 * 403 = サーバーのガードが弾いた (bdboard-teir)。トンネル経由で開くには、強いパスワードで起動した
 * トンネルのセッション (QR から開く) が要る。チャット・添付と同じ資格なので、写し先の文言は
 * writeAccessMessage.ts の TUNNEL_WRITE_HELP と同じ案内 (「スマホ公開」のQR / 12文字以上) に揃えている。
 */
export const LOCAL_FILE_ACCESS_HELP =
  'このファイルは開けません。スマホから開くには、PCの「スマホ公開」パネルで発行するQRコードから開き直してください。トンネルのパスワードが12文字未満のときは読み取り専用になり、ファイルも開けません。';

/** チケット詳細の「ファイル」欄に出す 1 行 (403 のとき)。 */
export const LOCAL_FILE_ACCESS_NOTICE =
  'ファイルはPCの「スマホ公開」のQRコードから開いたときだけ表示できます。';

export function isLocalFileAccessDenied(error: unknown): boolean {
  return error instanceof ApiError && error.status === 403;
}

export function localFileErrorMessage(error: unknown): string {
  const status = error instanceof ApiError ? error.status : undefined;
  if (status === 413) return 'ファイルが大きすぎて表示できません。';
  if (status === 415) return 'この種類のファイルは表示できません。';
  if (status === 403) return LOCAL_FILE_ACCESS_HELP;
  if (status === 400 || status === 404) return 'ファイルが見つからないか、開けない場所にあります。';
  return 'ファイルを読み込めませんでした。';
}
