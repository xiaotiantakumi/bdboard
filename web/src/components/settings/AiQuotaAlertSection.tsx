// bdboard-sso1.10 (PR-C): SettingsPanel.tsx の「AIクォータ通知閾値」フォームを移動しただけの
// コンポーネント。state・mutation は親(SettingsPanel)に残し、値とハンドラを props で受け取る
// 表示専用コンポーネント。JSX・className・aria属性・文言・DOM構造は移動前から変えていない。
import type { ReactNode } from 'react';

interface AiQuotaAlertSectionProps {
  value: string;
  onChange: (value: string) => void;
  defaultPercent: number;
  isSaving: boolean;
  isDirty: boolean;
  onSubmit: () => void;
  feedback: { message: ReactNode; isError: boolean };
}

export function AiQuotaAlertSection({
  value,
  onChange,
  defaultPercent,
  isSaving,
  isDirty,
  onSubmit,
  feedback,
}: AiQuotaAlertSectionProps) {
  return (
    <section className="settings-panel-section" aria-labelledby="ai-quota-alert-title">
      <h3 id="ai-quota-alert-title">AIクォータ通知閾値</h3>
      <p className="settings-panel-subtitle">
        AIクォータ残量がこの値(%)を下回ったらイベントセンターに通知します。
      </p>
      <form
        className="settings-panel-thresholds-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <label htmlFor="settings-ai-quota-threshold-percent">クォータ通知閾値 (%)</label>
        <input
          id="settings-ai-quota-threshold-percent"
          type="number"
          min={1}
          max={99}
          step={1}
          value={value}
          placeholder={String(defaultPercent)}
          disabled={isSaving}
          onChange={(event) => {
            onChange(event.target.value);
          }}
        />
        <div className="settings-panel-footer">
          <button type="submit" className="settings-panel-save" disabled={!isDirty || isSaving}>
            {isSaving ? '保存中…' : '閾値を保存'}
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
