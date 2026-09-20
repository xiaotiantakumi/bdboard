// bdboard-sso1.10 (PR-C): SettingsPanel.tsx の「滞留・liveness 閾値」フォームを移動しただけの
// コンポーネント。state・mutation は親(SettingsPanel)に残し、値とハンドラを props で受け取る
// 表示専用コンポーネント。JSX・className・aria属性・文言・DOM構造は移動前から変えていない。
import type { ReactNode } from 'react';
import { msToHours, msToMinutes } from './formatters';

interface BoardThresholdsSectionProps {
  values: {
    stalledHours: string;
    activeMinutes: string;
    idleMinutes: string;
    staleHours: string;
  };
  defaults: {
    stalledAfterMs: number;
    livenessActiveMs: number;
    livenessIdleMs: number;
    livenessStaleMs: number;
  };
  onStalledHoursChange: (value: string) => void;
  onActiveMinutesChange: (value: string) => void;
  onIdleMinutesChange: (value: string) => void;
  onStaleHoursChange: (value: string) => void;
  isSaving: boolean;
  isDirty: boolean;
  onSubmit: () => void;
  feedback: { message: ReactNode; isError: boolean };
}

export function BoardThresholdsSection({
  values,
  defaults,
  onStalledHoursChange,
  onActiveMinutesChange,
  onIdleMinutesChange,
  onStaleHoursChange,
  isSaving,
  isDirty,
  onSubmit,
  feedback,
}: BoardThresholdsSectionProps) {
  return (
    <section className="settings-panel-section" aria-labelledby="board-thresholds-title">
      <h3 id="board-thresholds-title">滞留・liveness 閾値</h3>
      <p className="settings-panel-subtitle">
        チケットの滞留判定とセッションの liveness 帯域を調整します。保存後、次回のボード取得から反映されます。
      </p>
      <form
        className="settings-panel-thresholds-form"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <label htmlFor="settings-stalled-hours">滞留判定 (時間)</label>
        <input
          id="settings-stalled-hours"
          type="number"
          min={1}
          step={1}
          value={values.stalledHours}
          placeholder={msToHours(defaults.stalledAfterMs)}
          disabled={isSaving}
          onChange={(event) => {
            onStalledHoursChange(event.target.value);
          }}
        />
        <label htmlFor="settings-active-minutes">liveness active (分)</label>
        <input
          id="settings-active-minutes"
          type="number"
          min={1}
          step={1}
          value={values.activeMinutes}
          placeholder={msToMinutes(defaults.livenessActiveMs)}
          disabled={isSaving}
          onChange={(event) => {
            onActiveMinutesChange(event.target.value);
          }}
        />
        <label htmlFor="settings-idle-minutes">liveness idle (分)</label>
        <input
          id="settings-idle-minutes"
          type="number"
          min={1}
          step={1}
          value={values.idleMinutes}
          placeholder={msToMinutes(defaults.livenessIdleMs)}
          disabled={isSaving}
          onChange={(event) => {
            onIdleMinutesChange(event.target.value);
          }}
        />
        <label htmlFor="settings-stale-hours">liveness stale (時間)</label>
        <input
          id="settings-stale-hours"
          type="number"
          min={1}
          step={1}
          value={values.staleHours}
          placeholder={msToHours(defaults.livenessStaleMs)}
          disabled={isSaving}
          onChange={(event) => {
            onStaleHoursChange(event.target.value);
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
