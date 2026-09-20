// bdboard-sso1.10 (PR-C): SettingsPanel.tsx の「健全性 (Hygiene) 閾値」フォームを移動しただけの
// コンポーネント。state・mutation は親(SettingsPanel)に残し、値とハンドラを props で受け取る
// 表示専用コンポーネント。JSX・className・aria属性・文言・DOM構造は移動前から変えていない。
import type { ReactNode } from 'react';
import type { HygieneThresholdsConfigDto } from '../../api';
import { msToDays } from './formatters';

interface HygieneThresholdsSectionProps {
  values: {
    staleInProgressDays: string;
    highPriorityMax: string;
    stalePendingDecisionDays: string;
    closedWithoutEvidenceDays: string;
  };
  data: HygieneThresholdsConfigDto;
  onStaleInProgressDaysChange: (value: string) => void;
  onHighPriorityMaxChange: (value: string) => void;
  onStalePendingDecisionDaysChange: (value: string) => void;
  onClosedWithoutEvidenceDaysChange: (value: string) => void;
  isSaving: boolean;
  isDirty: boolean;
  onSubmit: () => void;
  feedback: { message: ReactNode; isError: boolean };
}

export function HygieneThresholdsSection({
  values,
  data,
  onStaleInProgressDaysChange,
  onHighPriorityMaxChange,
  onStalePendingDecisionDaysChange,
  onClosedWithoutEvidenceDaysChange,
  isSaving,
  isDirty,
  onSubmit,
  feedback,
}: HygieneThresholdsSectionProps) {
  return (
    <section className="settings-panel-section" aria-labelledby="hygiene-thresholds-title">
      <h3 id="hygiene-thresholds-title">健全性 (Hygiene) 閾値</h3>
      <p className="settings-panel-subtitle">
        健全性ビューの検知に使う閾値を調整します。保存後、次回の健全性取得から反映されます。
      </p>
      <form
        className="settings-panel-thresholds-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <label htmlFor="settings-hygiene-stale-in-progress-days">in_progress 放置 (日)</label>
        <input
          id="settings-hygiene-stale-in-progress-days"
          type="number"
          min={1}
          step={1}
          value={values.staleInProgressDays}
          placeholder={msToDays(data.staleInProgressAfterMs)}
          disabled={isSaving}
          onChange={(event) => {
            onStaleInProgressDaysChange(event.target.value);
          }}
        />
        <label htmlFor="settings-hygiene-high-priority-max">高優先度上限 (P0=0)</label>
        <input
          id="settings-hygiene-high-priority-max"
          type="number"
          min={0}
          max={4}
          step={1}
          value={values.highPriorityMax}
          placeholder={String(data.highPriorityMax)}
          disabled={isSaving}
          onChange={(event) => {
            onHighPriorityMaxChange(event.target.value);
          }}
        />
        <label htmlFor="settings-hygiene-stale-pending-decision-days">確認待ち放置 (日)</label>
        <input
          id="settings-hygiene-stale-pending-decision-days"
          type="number"
          min={1}
          step={1}
          value={values.stalePendingDecisionDays}
          placeholder={msToDays(data.stalePendingDecisionAfterMs)}
          disabled={isSaving}
          onChange={(event) => {
            onStalePendingDecisionDaysChange(event.target.value);
          }}
        />
        <label htmlFor="settings-hygiene-closed-without-evidence-days">
          close 証拠チェック期間 (日)
        </label>
        <input
          id="settings-hygiene-closed-without-evidence-days"
          type="number"
          min={1}
          step={1}
          value={values.closedWithoutEvidenceDays}
          placeholder={msToDays(data.closedWithoutEvidenceWindowMs)}
          disabled={isSaving}
          onChange={(event) => {
            onClosedWithoutEvidenceDaysChange(event.target.value);
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
