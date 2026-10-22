import { useState } from 'react';
import type { ProjectDto } from '../api';
import { useMatchMedia } from '../hooks/useMatchMedia';
import { MOBILE_LAYOUT_MEDIA_QUERY } from '../mediaQueries';
import type { ViewMode } from '../uiPersistedState';
import { HeaderFilterMenu, countHeaderFilters, type HeaderFilterProps } from './header/HeaderFilterMenu';
import { HeaderSearchField } from './header/HeaderSearchField';
import { OverflowMenu, type OverflowMenuProps } from './OverflowMenu';
import { ProjectPicker } from './ProjectPicker';
import { StatusPill, type StatusPillProps } from './StatusPill';
import { useTunnelStatus } from './tunnel/useTunnelStatus';

export interface GlobalBarProps {
  view: ViewMode;
  onViewChange: (view: ViewMode) => void;
  onOpenSearch: () => void;
  status: StatusPillProps;
  projects: ProjectDto[];
  selectedProjectIds: string[];
  onToggleProject: (projectId: string, checked: boolean) => void;
  onSelectAllProjects: () => void;
  onClearAllProjects: () => void;
  onSaveProjectCombination: () => void;
  filter: HeaderFilterProps;
  onOpenTunnel: () => void;
  chatAvailable: boolean;
  onOpenChat: () => void;
  menu: Pick<
    OverflowMenuProps,
    | 'onRefresh'
    | 'isRefreshing'
    | 'onOpenHelp'
    | 'onOpenShortcuts'
    | 'tipsBannerDismissed'
    | 'onShowTipsBanner'
  >;
}

/**
 * bdboard-gyvv: ヘッダーは 1 行。左から タイトル+接続状態の丸 / プロジェクト / 検索 /
 * フィルタ / スマホ公開 / チャット / ⋯。モバイル (<=700px) は プロジェクト / 検索アイコン / ⋯ の
 * 上部バーに畳み、フィルタとチャットは ⋯ のシートに入れる。
 */
export function GlobalBar({
  view,
  onViewChange,
  onOpenSearch,
  status,
  projects,
  selectedProjectIds,
  onToggleProject,
  onSelectAllProjects,
  onClearAllProjects,
  onSaveProjectCombination,
  filter,
  onOpenTunnel,
  chatAvailable,
  onOpenChat,
  menu,
}: GlobalBarProps) {
  const isMobile = useMatchMedia(MOBILE_LAYOUT_MEDIA_QUERY);
  const [filterOpen, setFilterOpen] = useState(false);
  const [mobileSearchOpen, setMobileSearchOpen] = useState(false);
  const tunnelOn = useTunnelStatus().data?.state === 'on';
  const { filterText, setFilterText } = filter.filterState;
  const harnessProjects = projects
    .filter((p) => selectedProjectIds.length === 0 || selectedProjectIds.includes(p.id))
    .map((p) => ({ id: p.id, name: p.name }));

  if (isMobile && mobileSearchOpen) {
    return (
      <div className="global-bar global-bar-searching">
        <HeaderSearchField
          value={filterText}
          onChange={setFilterText}
          onClose={() => setMobileSearchOpen(false)}
          autoFocus
        />
      </div>
    );
  }

  return (
    <div className="global-bar">
      <div className="header-brand">
        <h1 className="header-title">bdboard</h1>
        <StatusPill {...status} />
      </div>

      <ProjectPicker
        projects={projects}
        selectedProjectIds={selectedProjectIds}
        onToggleProject={onToggleProject}
        onSelectAllProjects={onSelectAllProjects}
        onClearAllProjects={onClearAllProjects}
        onSaveCombination={onSaveProjectCombination}
      />

      <span className="header-spacer" aria-hidden="true" />

      {isMobile ? (
        <button
          type="button"
          className="header-icon-btn"
          aria-label="検索"
          onClick={() => setMobileSearchOpen(true)}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
          </svg>
        </button>
      ) : (
        <HeaderSearchField value={filterText} onChange={setFilterText} />
      )}

      <HeaderFilterMenu
        {...filter}
        open={filterOpen}
        onOpenChange={setFilterOpen}
        showButton={!isMobile}
      />

      {!isMobile && (
        <button
          type="button"
          className={`btn btn-tunnel${tunnelOn ? ' is-on' : ''}`}
          onClick={onOpenTunnel}
        >
          {tunnelOn ? 'スマホ公開中' : 'スマホ公開'}
        </button>
      )}

      {!isMobile && chatAvailable && (
        <button type="button" className="btn" onClick={onOpenChat}>
          チャット
        </button>
      )}

      <OverflowMenu
        view={view}
        onViewChange={onViewChange}
        onOpenSearch={onOpenSearch}
        harnessProjects={harnessProjects}
        mobile={
          isMobile
            ? {
                filterCount: countHeaderFilters(filter.filterState),
                onOpenFilter: () => setFilterOpen(true),
                chatAvailable,
                onOpenChat,
              }
            : undefined
        }
        {...menu}
      />
    </div>
  );
}
