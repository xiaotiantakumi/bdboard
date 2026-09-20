// bdboard-sso1.35: TunnelControl.tsx の「公開前(off)」のパスワード入力欄 +
// 公開ボタン + ヒント文を移動しただけの表示専用コンポーネント。
// state・mutation は useTunnelPublish (親で呼び出し) に残し、値とハンドラを
// props で受け取る。JSX・className・aria属性・文言・DOM構造は移動前から
// 変えていない。確認ダイアログは別コンポーネント (TunnelPublishConfirmDialog)。
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
    <>
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
          {startPending ? '送信中…' : 'スマホ用に公開'}
        </button>
      </div>

      {/* bdboard-cu4: 公開してからでは遅い情報なので、公開前に出す。
          12文字未満のパスワードで公開したトンネルは読み取り専用になる。 */}
      <p id="tunnel-password-write-hint" className="tunnel-help">
        パスワードが12文字未満だと、スマホからは読み取り専用になります（空欄=自動生成なら変更もできます）。
      </p>
    </>
  );
}
