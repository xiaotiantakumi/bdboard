import { useState } from 'react';
import { useCachedUpdateCheck } from '../hooks/useUpdateCheckStatus';
import { usePopoverViewportClamp } from '../hooks/usePopoverViewportClamp';
import { VIEW_ITEMS, type ViewMode } from '../uiPersistedState';
import { AiQuotaWidget } from './AiQuotaWidget';
import { useMenuDismiss } from './header/useMenuDismiss';
import { ProjectHarnessVersion } from './ProjectHarnessBadges';

/** モバイルだけ ⋯ の中に入る項目 (デスクトップはヘッダーのボタンとして常設)。 */
export interface OverflowMenuMobileActions {
  filterCount: number;
  onOpenFilter: () => void;
  chatAvailable: boolean;
  onOpenChat: () => void;
}

export interface OverflowMenuProps {
  view: ViewMode;
  onViewChange: (view: ViewMode) => void;
  onOpenSearch: () => void;
  onRefresh: () => void;
  isRefreshing: boolean;
  onOpenHelp: () => void;
  onOpenShortcuts: () => void;
  /** bdboard-h4xs.17: Tips バナーが閉じられ、永続化により非表示になっている状態か。 */
  tipsBannerDismissed: boolean;
  /** bdboard-h4xs.17: Tips バナーを再表示する(dismissed フラグを解除する)。 */
  onShowTipsBanner: () => void;
  /** harness の導入バージョンを出すプロジェクト (選択中。未選択なら全部)。 */
  harnessProjects: { id: string; name: string }[];
  mobile?: OverflowMenuMobileActions;
}

export function OverflowMenu({
  view,
  onViewChange,
  onOpenSearch,
  onRefresh,
  isRefreshing,
  onOpenHelp,
  onOpenShortcuts,
  tipsBannerDismissed,
  onShowTipsBanner,
  harnessProjects,
  mobile,
}: OverflowMenuProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const containerRef = useMenuDismiss(menuOpen, () => setMenuOpen(false));
  const popoverRef = usePopoverViewportClamp<HTMLDivElement>(menuOpen);
  const updateCheck = useCachedUpdateCheck();
  const updateData =
    updateCheck?.state === 'update-available' ? updateCheck : undefined;

  const handleItemClick = (action: () => void) => {
    setMenuOpen(false);
    action();
  };

  const item = (label: string, action: () => void, extra?: { current?: boolean; disabled?: boolean }) => (
    <button
      key={label}
      type="button"
      className="overflow-menu-item"
      role="menuitem"
      disabled={extra?.disabled}
      aria-current={extra?.current === true ? 'page' : undefined}
      onClick={() => handleItemClick(action)}
    >
      {label}
    </button>
  );

  // 設定と、まだ残っている補助ビュー (アクティビティ / 依存グラフ)。分割 (ボード) は
  // 既定のビューなので、別ビューにいるときだけ戻り先として出す。
  const viewItems = VIEW_ITEMS.filter((entry) => entry.view !== 'split').sort(
    (a, b) => Number(b.view === 'settings') - Number(a.view === 'settings'),
  );

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
        <div ref={popoverRef} className="overflow-menu-popover" role="menu">
          {mobile !== undefined && (
            <>
              {item(
                mobile.filterCount > 0 ? `フィルタ (${mobile.filterCount})` : 'フィルタ',
                mobile.onOpenFilter,
              )}
              {mobile.chatAvailable && item('チャット', mobile.onOpenChat)}
            </>
          )}
          {view !== 'split' && item('ボードに戻る', () => onViewChange('split'))}
          {viewItems.map((entry) =>
            item(entry.label, () => onViewChange(entry.view), { current: view === entry.view }),
          )}
          {item(isRefreshing ? '更新中…' : '手動更新', onRefresh, { disabled: isRefreshing })}
          {item('コマンドパレット (⌘K)', onOpenSearch)}
          <div className="overflow-menu-quota">
            <AiQuotaWidget />
          </div>
          {item('ヘルプ', onOpenHelp)}
          {item('キーボードショートカット', onOpenShortcuts)}
          {tipsBannerDismissed && item('Tips バナーを表示', onShowTipsBanner)}
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
          {harnessProjects.map((project) => (
            <ProjectHarnessVersion
              key={project.id}
              projectId={project.id}
              projectName={harnessProjects.length > 1 ? project.name : undefined}
            />
          ))}
          <p className="overflow-menu-footnote">
            盤面の鮮度・セッション数などの詳細は、タイトル横の接続状態の丸を開いて確認できます。
          </p>
        </div>
      )}
    </div>
  );
}
