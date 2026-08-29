import { useState } from 'react';
import { useCachedUpdateCheck } from '../hooks/useUpdateCheckStatus';
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
  const updateCheck = useCachedUpdateCheck();
  const updateData =
    updateCheck?.state === 'update-available' ? updateCheck : undefined;

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
        aria-label={updateData ? 'その他のメニュー (更新あり)' : 'その他のメニュー'}
        onClick={() => {
          setMenuOpen((open) => !open);
        }}
      >
        ⋯
        {updateData && <span className="overflow-menu-update-dot" aria-hidden="true" />}
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
          {updateData && (
            <a
              className="update-notice"
              href={updateData.releaseUrl}
              target="_blank"
              rel="noreferrer noopener"
              role="menuitem"
              onClick={() => {
                setMenuOpen(false);
              }}
            >
              新しいバージョン {updateData.latestVersion} が公開されています
            </a>
          )}
          <p className="overflow-menu-footnote">
            盤面の鮮度・セッション数などの詳細は、左のステータスピルを開いて確認できます。
          </p>
        </div>
      )}
    </div>
  );
}
