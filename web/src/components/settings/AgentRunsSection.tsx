// bdboard-sso1.10 (PR-C): SettingsPanel.tsx の「エージェント実行」フォームを移動しただけの
// コンポーネント。state・mutation は親(SettingsPanel)に残し、値とハンドラを props で受け取る
// 表示専用コンポーネント。JSX・className・aria属性・文言・DOM構造は移動前から変えていない。
import type { ReactNode } from 'react';

interface AgentRunsSectionProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  isSaving: boolean;
  isDirty: boolean;
  onSubmit: () => void;
  feedback: { message: ReactNode; isError: boolean };
}

export function AgentRunsSection({
  checked,
  onChange,
  isSaving,
  isDirty,
  onSubmit,
  feedback,
}: AgentRunsSectionProps) {
  return (
    <section className="settings-panel-section" aria-labelledby="agent-runs-title">
      <h3 id="agent-runs-title">エージェント実行</h3>
      <p className="settings-panel-subtitle">
        チケットの実行ボタンから Claude CLI を起動する機能の、リモートからの利用可否です。既定はオフで、オフのままでもPCのローカル画面からは実行できます。オンにするとトンネル経由の端末からもエージェントを起動できるようになります。
      </p>
      <p className="settings-panel-subtitle">
        保存した内容は次回のサーバー再起動から有効になります。稼働中のサーバーには反映されません（実行中のエージェントが設定を書き換えて即座に権限を広げられないようにするため）。
      </p>
      <form
        className="settings-panel-thresholds-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <label htmlFor="settings-allow-remote-agent-runs">
          リモート(トンネル経由)からのエージェント実行を許可する
        </label>
        <input
          id="settings-allow-remote-agent-runs"
          type="checkbox"
          checked={checked}
          disabled={isSaving}
          onChange={(event) => {
            onChange(event.target.checked);
          }}
        />
        <div className="settings-panel-footer">
          <button type="submit" className="settings-panel-save" disabled={!isDirty || isSaving}>
            {isSaving ? '保存中…' : '設定を保存'}
          </button>
          <div
            className="settings-panel-feedback"
            aria-live="polite"
            role={feedback.isError ? 'alert' : undefined}
          >
            {feedback.message}
          </div>
        </div>
      </form>
    </section>
  );
}
