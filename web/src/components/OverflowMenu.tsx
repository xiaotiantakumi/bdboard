import { useState } from 'react';
import { useExclusivePopover } from './PopoverCoordinator';

export interface OverflowMenuProps {
  onOpenSettings: () => void;
  onOpenTunnel: () => void;
  onOpenHelp: () => void;
  onOpenShortcuts: () => void;
}

export function OverflowMenu({
  onOpenSettings,
  onOpenTunnel,
  onOpenHelp,
  onOpenShortcuts,
}: OverflowMenuProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const containerRef = useExclusivePopover('overflow-menu', menuOpen, setMenuOpen);

  const handleItemClick = (action: () => void) => {
    setMenuOpen(false);
    action();
  };

  return (
    <div ref={containerRef} className="overflow-menu header-group">
      <button
        type="button"
        className="overflow-menu-button"
        aria-expanded={menuOpen}
        aria-haspopup="menu"
        aria-label="その他のメニュー"
        onClick={() => {
          setMenuOpen((open) => !open);
        }}
      >
        ⋯
      </button>

      {menuOpen && (
        <div className="overflow-menu-popover" role="menu">
          <button
            type="button"
            className="overflow-menu-item"
            role="menuitem"
            onClick={() => handleItemClick(onOpenSettings)}
          >
            設定
          </button>
          <button
            type="button"
            className="overflow-menu-item"
            role="menuitem"
            onClick={() => handleItemClick(onOpenTunnel)}
          >
            スマホ公開
          </button>
          <button
            type="button"
            className="overflow-menu-item"
            role="menuitem"
            onClick={() => handleItemClick(onOpenHelp)}
          >
            ヘルプ
          </button>
          <button
            type="button"
            className="overflow-menu-item"
            role="menuitem"
            onClick={() => handleItemClick(onOpenShortcuts)}
          >
            キーボードショートカット
          </button>
          <p className="overflow-menu-footnote">
            盤面の鮮度・セッション数などの詳細は、左のステータスピルを開いて確認できます。
          </p>
        </div>
      )}
    </div>
  );
}
