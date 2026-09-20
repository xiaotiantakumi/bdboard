// bdboard-sso1.10 (PR-B): SettingsPanel.tsx の「現在有効なスキャンルート」表示ブロックを
// 移動しただけのコンポーネント。state・mutation は親(SettingsPanel)に残し、値を props で
// 受け取る表示専用コンポーネント。JSX・className・aria属性・文言・DOM構造は移動前から
// 変えていない。
interface EffectiveScanRootsSectionProps {
  currentLabel: string;
  currentRoots: readonly string[];
}

export function EffectiveScanRootsSection({
  currentLabel,
  currentRoots,
}: EffectiveScanRootsSectionProps) {
  return (
    <section className="settings-panel-section" aria-labelledby="effective-scan-roots-title">
      <div className="settings-panel-section-header">
        <h3 id="effective-scan-roots-title">現在有効なスキャンルート</h3>
        <span className="settings-panel-badge">{currentLabel}</span>
      </div>
      {currentRoots.length > 0 ? (
        <ul className="settings-panel-root-list">
          {currentRoots.map((path) => (
            <li key={path}>{path}</li>
          ))}
        </ul>
      ) : (
        <p className="settings-panel-empty">有効なスキャンルートがありません</p>
      )}
    </section>
  );
}
