// bdboard-sso1.35: TunnelControl.tsx の「公開中(on)」パネル(書き込み可否表示 +
// QR表示/非表示 + 停止ボタン)を移動しただけの表示専用コンポーネント。
// state・mutation は useTunnelQr / useTunnelStop (親で呼び出し) に残し、
// 値とハンドラを props で受け取る。JSX・className・aria属性・文言・DOM構造は
// 移動前から変えていない。
import { QRCodeSVG } from 'qrcode.react';
import { buildTunnelTokenUrl } from '../../tunnelQr';
import { accessTokenErrorMessage } from './tunnelHelpers';

export interface TunnelOnPanelProps {
  writeAccess: boolean | undefined;
  qrVisible: boolean;
  onQrToggle: () => void;
  tokenPending: boolean;
  tokenIsError: boolean;
  tokenError: unknown;
  tunnelUrl: string;
  accessToken: string | null;
  onStop: () => void;
  stopDisabled: boolean;
  stopPending: boolean;
}

export function TunnelOnPanel({
  writeAccess,
  qrVisible,
  onQrToggle,
  tokenPending,
  tokenIsError,
  tokenError,
  tunnelUrl,
  accessToken,
  onStop,
  stopDisabled,
  stopPending,
}: TunnelOnPanelProps) {
  return (
    <div className="tunnel-on-panel">
      {/* bdboard-cu4: スマホ側で「書き込めない理由」が分からず 403 トーストだけが
          出る状態だったので、公開中のトンネルが読み書きできるのかをここに出す。
          サーバーは state==='on' のとき必ず writeAccess を返す(bdboard-9rz)。
          未定義になるのは古いサーバーと話しているときだけなので、その場合は
          断定せずに何も出さない。 */}
      {writeAccess !== undefined && (
        <div className="tunnel-field">
          <span className="tunnel-field-label">スマホからの操作</span>
          {writeAccess ? (
            <p className="tunnel-write-access tunnel-write-access-on">
              変更もできます。公開後のQRコードからスマホで開いてください。
            </p>
          ) : (
            <p className="tunnel-write-access tunnel-write-access-off">
              読み取り専用です。パスワードが12文字未満のためチケットの変更・コメント・チャットはできません。変更もしたい場合は、いったん公開を停止して、パスワード欄を空欄（自動生成）にするか12文字以上のパスワードで公開し直してください。
            </p>
          )}
        </div>
      )}
      <div className="tunnel-field">
        <span className="tunnel-field-label">スマホで開く</span>
        <div className="tunnel-field-row">
          <button
            type="button"
            className="btn btn-small"
            onClick={onQrToggle}
            aria-expanded={qrVisible}
          >
            {qrVisible ? 'QRを隠す' : 'QRを表示'}
          </button>
          <span className="tunnel-qr-hint">
            カメラで読むとログイン済みの状態で開けます（変更操作もこの入口からのみ）
          </span>
        </div>
        {qrVisible && (
          <div className="tunnel-qr">
            {tokenPending && <p className="tunnel-qr-status">準備中…</p>}
            {tokenIsError && (
              <p className="tunnel-error-message">
                {accessTokenErrorMessage(tokenError)}
              </p>
            )}
            {accessToken !== null && (
              <>
                <QRCodeSVG
                  value={buildTunnelTokenUrl(tunnelUrl, accessToken)}
                  size={192}
                  level="M"
                  marginSize={2}
                  title="トンネルURL(ワンタイムトークンつき)のQRコード"
                />
                <p className="tunnel-qr-note">
                  1回だけ使える入場用コードです。有効期限は約5分。
                </p>
              </>
            )}
          </div>
        )}
      </div>
      <button
        type="button"
        className="btn"
        onClick={onStop}
        disabled={stopDisabled}
      >
        {stopPending ? '停止中…' : '公開を停止'}
      </button>
    </div>
  );
}
