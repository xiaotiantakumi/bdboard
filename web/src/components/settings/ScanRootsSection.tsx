// bdboard-sso1.10 (PR-B): SettingsPanel.tsx の「ユーザー設定ルート」表示・編集ブロックを
// 移動しただけのコンポーネント。state・mutation は親(SettingsPanel)に残し、値とハンドラを
// props で受け取る表示専用コンポーネント。JSX・className・aria属性・文言・DOM構造は移動前
// から変えていない。
import { DANGEROUS_SCAN_ROOT_ROW_WARNING } from './errors';
import { looksObviouslyDangerous } from './validators';

interface ScanRootsSectionProps {
  envOverride: boolean;
  scanRoots: readonly string[];
  onRemovePath: (path: string) => void;
  isSaving: boolean;
  newPath: string;
  onNewPathChange: (value: string) => void;
  pathHint: string;
  onAddPath: () => void;
}

export function ScanRootsSection({
  envOverride,
  scanRoots,
  onRemovePath,
  isSaving,
  newPath,
  onNewPathChange,
  pathHint,
  onAddPath,
}: ScanRootsSectionProps) {
  return (
    <section className="settings-panel-section" aria-labelledby="user-scan-roots-title">
      <h3 id="user-scan-roots-title">
        {envOverride ? '保存済み設定(現在は無効)' : 'ユーザー設定ルート'}
      </h3>
      {scanRoots.length > 0 ? (
        <ul className="settings-panel-edit-list settings-panel-scan-root-list">
          {scanRoots.map((path) => (
            <li key={path}>
              <div className="settings-panel-edit-row">
                <span>{path}</span>
                <button
                  type="button"
                  onClick={() => onRemovePath(path)}
                  disabled={isSaving}
                  aria-label={`スキャンルート ${path} を削除`}
                >
                  削除
                </button>
              </div>
              {looksObviouslyDangerous(path) && (
                <p className="settings-panel-path-danger" role="alert">
                  {DANGEROUS_SCAN_ROOT_ROW_WARNING}
                </p>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="settings-panel-empty">ユーザー設定ルートはありません</p>
      )}
      <form
        className="settings-panel-add-form"
        onSubmit={(event) => {
          event.preventDefault();
          onAddPath();
        }}
      >
        <label htmlFor="settings-scan-root-input">パスを追加</label>
        <div className="settings-panel-add-row">
          <input
            id="settings-scan-root-input"
            type="text"
            value={newPath}
            disabled={isSaving}
            onChange={(event) => onNewPathChange(event.target.value)}
          />
          <button type="submit" disabled={isSaving}>
            追加
          </button>
        </div>
        {pathHint && <p className="settings-panel-path-hint">{pathHint}</p>}
      </form>
    </section>
  );
}
