// bdboard-sso1.35: TunnelControl.tsx の純ヘルパー・定数を、挙動を変えずに
// このファイルへ移動しただけのもの。ThroughputStats.tsx / HygienePanel.tsx の
// 「pure helpers を兄弟ディレクトリへ移す」パターン(PR #560 / #544)を踏襲する。
//
// TUNNEL_QUERY_KEY はここには置かない — useTunnelStatus.ts が唯一の定義元
// (理由はそちらのコメント参照)。setQueryData 側で使う場合はそこから import する。
import { ApiError } from '../../api';
import { TUNNEL_NOT_RUNNING_HELP } from '../../writeAccessMessage';

export const POLL_INTERVAL_MS = 1200;

export function isLocalOnlyError(error: unknown): boolean {
  return error instanceof ApiError && error.status === 403;
}

export function accessTokenErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 409) {
      // bdboard-o2o: writeAccessMessage.ts の定数と共有し、文言の fork を防ぐ。
      return TUNNEL_NOT_RUNNING_HELP;
    }
    if (error.status === 403) {
      return 'この操作はローカルの画面からのみ実行できます';
    }
  }
  // Deliberately generic: the server's own message is not surfaced here, so a
  // token can never reach the screen through an error path.
  return 'QRコードの準備に失敗しました';
}
