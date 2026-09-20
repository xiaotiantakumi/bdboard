// bdboard-sso1.10 (PR-B): SettingsPanel.tsx の「除外パス」表示・編集ブロックを移動しただけの
// コンポーネント。state・mutation は親(SettingsPanel)に残し、値とハンドラを props で受け取る
// 表示専用コンポーネント。JSX・className・aria属性・文言・DOM構造は移動前から変えていない。
interface ExcludePathsSectionProps {
  envOverride: boolean;
  excludePaths: readonly string[];
  onRemoveExcludePath: (path: string) => void;
  isSaving: boolean;
  newExcludePath: string;
  onNewExcludePathChange: (value: string) => void;
  excludePathHint: string;
  onAddExcludePath: () => void;
}

export function ExcludePathsSection({
  envOverride,
  excludePaths,
  onRemoveExcludePath,
  isSaving,
  newExcludePath,
  onNewExcludePathChange,
  excludePathHint,
  onAddExcludePath,
}: ExcludePathsSectionProps) {
  return (
    <section className="settings-panel-section" aria-labelledby="exclude-paths-title">
      <h3 id="exclude-paths-title">{envOverride ? '除外パス(現在は無効)' : '除外パス'}</h3>
      <p className="settings-panel-subtitle">
        {envOverride
          ? '環境変数 BDBOARD_SCAN_ROOTS が有効なため、保存済みの除外パスは現在スキャンに適用されません。'
          : 'ここに追加した絶対パス配下のプロジェクトはスキャン時に除外されます。'}
      </p>
      {excludePaths.length > 0 ? (
        <ul className="settings-panel-edit-list">
          {excludePaths.map((path) => (
            <li key={path}>
              <span>{path}</span>
              <button
                type="button"
                onClick={() => onRemoveExcludePath(path)}
                disabled={isSaving}
                aria-label={`除外パス ${path} を削除`}
              >
                削除
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="settings-panel-empty">除外パスはありません</p>
      )}
      <form
        className="settings-panel-add-form"
        onSubmit={(event) => {
          event.preventDefault();
          onAddExcludePath();
        }}
      >
        <label htmlFor="settings-exclude-path-input">除外パスを追加</label>
        <div className="settings-panel-add-row">
          <input
            id="settings-exclude-path-input"
            type="text"
            value={newExcludePath}
            disabled={isSaving}
            onChange={(event) => onNewExcludePathChange(event.target.value)}
          />
          <button type="submit" disabled={isSaving}>
            追加
          </button>
        </div>
        {excludePathHint && <p className="settings-panel-path-hint">{excludePathHint}</p>}
      </form>
    </section>
  );
}
