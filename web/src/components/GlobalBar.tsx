import type { ProjectDto } from '../api';
import { VIEW_ITEMS, type ViewMode } from '../uiPersistedState';
import type { StreamState } from '../useBoardStream';
import { OverflowMenu } from './OverflowMenu';
import { ProjectPicker } from './ProjectPicker';
import { StatusPill } from './StatusPill';

export interface GlobalBarProps {
  view: ViewMode;
  onViewChange: (view: ViewMode) => void;
  notificationUnreadCount: number;
  onOpenSearch: () => void;
  streamState: StreamState;
  connectStalled?: boolean;
  lastContactAtMs: number | null | undefined;
  generatedAt: string | null | undefined;
  lastRefreshAt: string | null | undefined;
  totalSessionCount: number;
  activeSessionCount: number;
  onOpenSessionList: () => void;
  statusDetailOpen: boolean;
  onStatusDetailOpenChange: (open: boolean) => void;
  projects: ProjectDto[];
  selectedProjectIds: string[];
  onToggleProject: (projectId: string, checked: boolean) => void;
  onSelectAllProjects: () => void;
  onClearAllProjects: () => void;
  onSaveProjectCombination: () => void;
  onOpenSettings: () => void;
  onOpenTunnel: () => void;
  onOpenHelp: () => void;
  onOpenShortcuts: () => void;
}

export function GlobalBar({
  view,
  onViewChange,
  notificationUnreadCount,
  onOpenSearch,
  streamState,
  connectStalled = false,
  lastContactAtMs,
  generatedAt,
  lastRefreshAt,
  totalSessionCount,
  activeSessionCount,
  onOpenSessionList,
  statusDetailOpen,
  onStatusDetailOpenChange,
  projects,
  selectedProjectIds,
  onToggleProject,
  onSelectAllProjects,
  onClearAllProjects,
  onSaveProjectCombination,
  onOpenSettings,
  onOpenTunnel,
  onOpenHelp,
  onOpenShortcuts,
}: GlobalBarProps) {
  return (
    <div className="global-bar">
      <h1 className="header-title">bdboard</h1>

      <div className="header-group view-switcher">
        <span className="header-label">ビュー</span>
        <div className="toggle-group">
          {VIEW_ITEMS.map((item) => (
            <button
              key={item.view}
              type="button"
              className={`toggle-btn${view === item.view ? ' active' : ''}`}
              onClick={() => onViewChange(item.view)}
            >
              {item.label}
              {item.view === 'events' && notificationUnreadCount > 0
                ? ` (${notificationUnreadCount})`
                : ''}
            </button>
          ))}
        </div>
      </div>

      <button
        type="button"
        className="btn btn-search"
        aria-label="コマンドパレット (Cmd+K)"
        onClick={onOpenSearch}
      >
        検索
      </button>

      <StatusPill
        streamState={streamState}
        connectStalled={connectStalled}
        lastContactAtMs={lastContactAtMs}
        generatedAt={generatedAt}
        lastRefreshAt={lastRefreshAt}
        totalSessionCount={totalSessionCount}
        activeSessionCount={activeSessionCount}
        onOpenSessionList={onOpenSessionList}
        open={statusDetailOpen}
        onOpenChange={onStatusDetailOpenChange}
      />

      <ProjectPicker
        projects={projects}
        selectedProjectIds={selectedProjectIds}
        onToggleProject={onToggleProject}
        onSelectAllProjects={onSelectAllProjects}
        onClearAllProjects={onClearAllProjects}
        onSaveCombination={onSaveProjectCombination}
      />

      <OverflowMenu
        onOpenSettings={onOpenSettings}
        onOpenTunnel={onOpenTunnel}
        onOpenHelp={onOpenHelp}
        onOpenShortcuts={onOpenShortcuts}
      />
    </div>
  );
}
