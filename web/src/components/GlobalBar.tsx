import type { ProjectDto } from '../api';
import type { ViewMode } from '../uiPersistedState';
import type { StreamState } from '../useBoardStream';
import { OverflowMenu } from './OverflowMenu';
import { StatusPill } from './StatusPill';

export interface GlobalBarProps {
  view: ViewMode;
  onViewChange: (view: ViewMode) => void;
  notificationUnreadCount: number;
  onOpenSearch: () => void;
  streamState: StreamState;
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
          <button
            type="button"
            className={`toggle-btn${view === 'merged' ? ' active' : ''}`}
            onClick={() => onViewChange('merged')}
          >
            統合
          </button>
          <button
            type="button"
            className={`toggle-btn${view === 'split' ? ' active' : ''}`}
            onClick={() => onViewChange('split')}
          >
            分割
          </button>
          <button
            type="button"
            className={`toggle-btn${view === 'next' ? ' active' : ''}`}
            onClick={() => onViewChange('next')}
          >
            Next Up
          </button>
          <button
            type="button"
            className={`toggle-btn${view === 'activity' ? ' active' : ''}`}
            onClick={() => onViewChange('activity')}
          >
            アクティビティ
          </button>
          <button
            type="button"
            className={`toggle-btn${view === 'digest' ? ' active' : ''}`}
            onClick={() => onViewChange('digest')}
          >
            ダイジェスト
          </button>
          <button
            type="button"
            className={`toggle-btn${view === 'stats' ? ' active' : ''}`}
            onClick={() => onViewChange('stats')}
          >
            統計
          </button>
          <button
            type="button"
            className={`toggle-btn${view === 'hygiene' ? ' active' : ''}`}
            onClick={() => onViewChange('hygiene')}
          >
            健全性
          </button>
          <button
            type="button"
            className={`toggle-btn${view === 'graph' ? ' active' : ''}`}
            onClick={() => onViewChange('graph')}
          >
            依存グラフ
          </button>
          <button
            type="button"
            className={`toggle-btn${view === 'events' ? ' active' : ''}`}
            onClick={() => onViewChange('events')}
          >
            イベント
            {notificationUnreadCount > 0 ? ` (${notificationUnreadCount})` : ''}
          </button>
          <button
            type="button"
            className={`toggle-btn${view === 'settings' ? ' active' : ''}`}
            onClick={() => onViewChange('settings')}
          >
            設定
          </button>
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
        lastContactAtMs={lastContactAtMs}
        generatedAt={generatedAt}
        lastRefreshAt={lastRefreshAt}
        totalSessionCount={totalSessionCount}
        activeSessionCount={activeSessionCount}
        onOpenSessionList={onOpenSessionList}
        open={statusDetailOpen}
        onOpenChange={onStatusDetailOpenChange}
      />

      <div className="header-group project-filter">
        <details>
          <summary>
            プロジェクト
            {selectedProjectIds.length > 0
              ? ` (${selectedProjectIds.length} 件選択)`
              : ' (全件)'}
          </summary>
          <div className="project-list">
            <button type="button" className="btn btn-small" onClick={onSelectAllProjects}>
              全選択
            </button>
            <button type="button" className="btn btn-small" onClick={onClearAllProjects}>
              全解除
            </button>
            {projects.map((project) => (
              <label key={project.id} className="checkbox-label">
                <input
                  type="checkbox"
                  checked={selectedProjectIds.includes(project.id)}
                  onChange={(event) => onToggleProject(project.id, event.target.checked)}
                />
                {project.name}
              </label>
            ))}
          </div>
        </details>
      </div>

      <OverflowMenu
        onOpenSettings={onOpenSettings}
        onOpenTunnel={onOpenTunnel}
        onOpenHelp={onOpenHelp}
        onOpenShortcuts={onOpenShortcuts}
      />
    </div>
  );
}
