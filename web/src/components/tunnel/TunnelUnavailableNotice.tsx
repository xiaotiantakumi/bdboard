// bdboard-sso1.35: TunnelControl.tsx の「cloudflared が見つからない」表示を
// 移動しただけの表示専用コンポーネント。state を持たないため props も無い。
// JSX・className・文言は移動前から変えていない。
export function TunnelUnavailableNotice() {
  return (
    <>
      <p className="tunnel-help">
        cloudflared が見つかりません。ローカルにインストールしてください。
      </p>
      <button
        type="button"
        className="btn"
        disabled
        title="cloudflared が見つかりません"
      >
        スマホ用に公開
      </button>
    </>
  );
}
