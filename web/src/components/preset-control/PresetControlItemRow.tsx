// bdboard-sso1.37: PresetControl.tsx の1プリセット分の表示行(適用ボタン+操作メニュー)
// を移動しただけのコンポーネント。state は親(usePresetControlPopover)に残し、値と
// ハンドラを props で受け取る表示専用コンポーネント。JSX・className・aria属性・
// 文言・DOM構造は移動前から変えていない。
import type { BoardFilterPreset } from '../../uiPersistedState';

export interface PresetControlItemRowProps {
  preset: BoardFilterPreset;
  isActive: boolean;
  dirty: boolean;
  isMenuOpen: boolean;
  onApply: () => void;
  onToggleMenu: () => void;
  onStartRename: () => void;
  onDuplicate: () => void;
  onToggleDefault: () => void;
  onDelete: () => void;
}

export function PresetControlItemRow({
  preset,
  isActive,
  dirty,
  isMenuOpen,
  onApply,
  onToggleMenu,
  onStartRename,
  onDuplicate,
  onToggleDefault,
  onDelete,
}: PresetControlItemRowProps) {
  return (
    <div className="preset-control-item">
      <div className="preset-control-row">
        <button
          type="button"
          className={`preset-control-apply${isActive ? ' preset-control-apply-active' : ''}`}
          aria-pressed={isActive}
          onClick={onApply}
        >
          <span className="preset-control-check" aria-hidden="true">
            {isActive ? '✓' : ''}
          </span>
          <span className="preset-control-name">{preset.name}</span>
          {preset.isDefault === true && (
            <span className="preset-control-badge preset-control-badge-default">
              既定
            </span>
          )}
          {isActive && dirty && (
            <span className="preset-control-badge preset-control-badge-dirty">
              変更あり
            </span>
          )}
        </button>

        <button
          type="button"
          className="preset-control-row-menu-button"
          aria-haspopup="menu"
          aria-expanded={isMenuOpen}
          aria-label={`「${preset.name}」の操作`}
          onClick={onToggleMenu}
        >
          ⋯
        </button>
      </div>

      {isMenuOpen && (
        <div className="preset-control-row-menu" role="menu">
          <button
            type="button"
            role="menuitem"
            className="preset-control-row-menu-item"
            onClick={onStartRename}
          >
            名前を変更
          </button>
          <button
            type="button"
            role="menuitem"
            className="preset-control-row-menu-item"
            onClick={onDuplicate}
          >
            複製
          </button>
          <button
            type="button"
            role="menuitem"
            className="preset-control-row-menu-item"
            onClick={onToggleDefault}
          >
            {preset.isDefault === true ? '既定を解除' : '既定にする'}
          </button>
          <button
            type="button"
            role="menuitem"
            className="preset-control-row-menu-item preset-control-row-menu-danger"
            onClick={onDelete}
          >
            削除
          </button>
        </div>
      )}
    </div>
  );
}
