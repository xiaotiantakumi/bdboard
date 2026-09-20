// bdboard-sso1.10 (PR-C): SettingsPanel.tsx の「WIP上限」フォームを移動しただけのコンポーネント。
// state・mutation は親(SettingsPanel)に残し、値とハンドラを props で受け取る表示専用コンポーネント。
// props が12個を超えないよう、全体上限/プロジェクト別上限一覧/追加行をそれぞれ束ねたオブジェクトに
// している。JSX・className・aria属性・文言・DOM構造は移動前から変えていない。
import type { ReactNode } from 'react';
import type { ProjectDto } from '../../api';
import { parseWipLimit } from './validators';
import type { ProjectWipOverrideRow } from './wipOverrides';

interface WipLimitsSectionProps {
  global: {
    value: string;
    onChange: (value: string) => void;
  };
  overrides: {
    rows: ProjectWipOverrideRow[];
    projects: ProjectDto[] | undefined;
    projectsPending: boolean;
    onLimitChange: (index: number, value: string) => void;
    onRemove: (index: number) => void;
  };
  addRow: {
    projectId: string;
    onProjectIdChange: (value: string) => void;
    limit: string;
    onLimitChange: (value: string) => void;
    onAdd: () => void;
  };
  isSaving: boolean;
  isDirty: boolean;
  onSubmit: () => void;
  feedback: { message: ReactNode; isError: boolean };
}

export function WipLimitsSection({
  global,
  overrides,
  addRow,
  isSaving,
  isDirty,
  onSubmit,
  feedback,
}: WipLimitsSectionProps) {
  return (
    <section className="settings-panel-section" aria-labelledby="wip-limits-title">
      <h3 id="wip-limits-title">WIP上限</h3>
      <p className="settings-panel-subtitle">
        In Progress レーンの同時着手枚数の上限を設定します。超過時はレーンヘッダーが警告表示されます。空欄は上限なしです。
      </p>
      <form
        className="settings-panel-thresholds-form"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <label htmlFor="settings-global-wip-limit">In Progress 上限 (全体)</label>
        <input
          id="settings-global-wip-limit"
          type="number"
          min={1}
          step={1}
          value={global.value}
          placeholder="未設定 (上限なし)"
          disabled={isSaving}
          onChange={(event) => {
            global.onChange(event.target.value);
          }}
        />
        <p className="settings-panel-subtitle">プロジェクト別の上限</p>
        {overrides.rows.length > 0 ? (
          <ul className="settings-panel-edit-list">
            {overrides.rows.map((row, index) => {
              const projectName =
                overrides.projects?.find((project) => project.id === row.projectId)?.name ??
                row.projectId;
              return (
                <li key={`${row.projectId}-${index}`} className="settings-panel-wip-override-row">
                  <span className="settings-panel-wip-override-label">{projectName}</span>
                  <input
                    type="number"
                    min={1}
                    step={1}
                    aria-label={`${projectName} の WIP上限`}
                    value={row.limit}
                    disabled={isSaving}
                    onChange={(event) => {
                      overrides.onLimitChange(index, event.target.value);
                    }}
                  />
                  <button
                    type="button"
                    disabled={isSaving}
                    onClick={() => {
                      overrides.onRemove(index);
                    }}
                  >
                    削除
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="settings-panel-empty">プロジェクト別の上限はありません</p>
        )}
        <div className="settings-panel-add-form">
          <label htmlFor="settings-wip-project-select">プロジェクト別上限を追加</label>
          <div className="settings-panel-add-row">
            <select
              id="settings-wip-project-select"
              value={addRow.projectId}
              disabled={isSaving || overrides.projectsPending}
              onChange={(event) => addRow.onProjectIdChange(event.target.value)}
            >
              <option value="">プロジェクトを選択</option>
              {(overrides.projects ?? [])
                .filter(
                  (project) => !overrides.rows.some((row) => row.projectId === project.id),
                )
                .map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
            </select>
            <input
              type="number"
              min={1}
              step={1}
              aria-label="追加する WIP上限"
              value={addRow.limit}
              placeholder="上限"
              disabled={isSaving}
              onChange={(event) => addRow.onLimitChange(event.target.value)}
            />
            <button
              type="button"
              disabled={
                isSaving || addRow.projectId === '' || parseWipLimit(addRow.limit) === undefined
              }
              onClick={() => {
                addRow.onAdd();
              }}
            >
              追加
            </button>
          </div>
        </div>
        <div className="settings-panel-footer">
          <button type="submit" className="settings-panel-save" disabled={!isDirty || isSaving}>
            {isSaving ? '保存中…' : 'WIP上限を保存'}
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
