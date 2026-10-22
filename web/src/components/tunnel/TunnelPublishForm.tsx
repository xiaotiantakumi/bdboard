// bdboard-y2qx: 公開前(off)に出す「詳細」。既定の流れは開いた時点で自動公開
// (自動生成パスワード) なので、自分でパスワードを決めたいときだけ使う折りたたみ。
export interface TunnelPublishFormProps {
  passwordInput: string;
  onPasswordChange: (value: string) => void;
  passwordDisabled: boolean;
  startDisabled: boolean;
  authUnavailable: boolean;
  onRequestPublish: () => void;
  startPending: boolean;
}

export function TunnelPublishForm({
  passwordInput,
  onPasswordChange,
  passwordDisabled,
  startDisabled,
  authUnavailable,
  onRequestPublish,
  startPending,
}: TunnelPublishFormProps) {
  return (
    <details className="tunnel-details">
      <summary>詳細</summary>
      <div className="tunnel-off-row">
        <input
          type="password"
          className="tunnel-input"
          value={passwordInput}
          onChange={(event) => onPasswordChange(event.target.value)}
          placeholder="未入力ならランダム生成"
          disabled={passwordDisabled}
          aria-label="トンネル用パスワード（任意）"
          aria-describedby="tunnel-password-write-hint"
        />
        <button
          type="button"
          className="btn"
          onClick={onRequestPublish}
          disabled={startDisabled}
          title={
            authUnavailable
              ? 'Basic Authが有効でないためトンネル公開はできません'
              : undefined
          }
        >
          {startPending ? '送信中…' : 'このパスワードで公開'}
        </button>
      </div>
      {/* bdboard-cu4: 12文字未満のパスワードで公開したトンネルは読み取り専用になる。 */}
      <p id="tunnel-password-write-hint" className="tunnel-help">
        パスワードが12文字未満だと、スマホからは読み取り専用になります（空欄=自動生成なら変更もできます）。
      </p>
    </details>
  );
}
