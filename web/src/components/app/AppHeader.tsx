import type { ProjectDto } from '../../api';
import type { StreamState } from '../../useBoardStream';
import type { ViewMode } from '../../uiPersistedState';
import { ErrorBoundary } from '../ErrorBoundary';
import { GlobalBar } from '../GlobalBar';
import type { HeaderFilterProps } from '../header/HeaderFilterMenu';

export interface AppHeaderProps {
  view: ViewMode;
  onViewChange: (view: ViewMode) => void;
  onOpenSearch: () => void;
  connection: {
    streamState: StreamState;
    connectStalled: boolean;
    lastContactAtMs: number | null | undefined;
    generatedAt: string | null | undefined;
    lastRefreshAt: string | null | undefined;
  };
  statusDetail: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
  };
  projects: {
    list: ProjectDto[];
    selectedIds: string[];
    onToggle: (projectId: string, checked: boolean) => void;
    onSelectAll: () => void;
    onClearAll: () => void;
    onSaveCombination: () => void;
  };
  onOpenTunnel: () => void;
  onOpenHelp: () => void;
  onOpenShortcuts: () => void;
  tipsBanner: {
    dismissed: boolean;
    onShow: () => void;
  };
  /** フィルタ (優先度/種別/ラベル/プリセット/done・滞留) と検索欄の文字。 */
  filter: HeaderFilterProps;
  toolbar: {
    onRefresh: () => void;
    isRefreshing: boolean;
    chatAvailable: boolean;
    onOpenChat: () => void;
  };
}

/**
 * bdboard-62p4 候補1「ヘッダー」。GlobalBar を ErrorBoundary でラップして値を
 * 橋渡しするだけの表示専用コンポーネント。state・effect は持たない。
 * bdboard-gyvv: ビュー切替タブ行・ツールバー行を無くし、GlobalBar 1 行に集約した。
 */
export function AppHeader({
  view,
  onViewChange,
  onOpenSearch,
  connection,
  statusDetail,
  projects,
  onOpenTunnel,
  onOpenHelp,
  onOpenShortcuts,
  tipsBanner,
  filter,
  toolbar,
}: AppHeaderProps) {
  return (
    <header className="header">
      <ErrorBoundary label="ヘッダー">
        <GlobalBar
          view={view}
          onViewChange={onViewChange}
          onOpenSearch={onOpenSearch}
          status={{
            streamState: connection.streamState,
            connectStalled: connection.connectStalled,
            lastContactAtMs: connection.lastContactAtMs,
            generatedAt: connection.generatedAt,
            lastRefreshAt: connection.lastRefreshAt,
            open: statusDetail.open,
            onOpenChange: statusDetail.onOpenChange,
          }}
          projects={projects.list}
          selectedProjectIds={projects.selectedIds}
          onToggleProject={projects.onToggle}
          onSelectAllProjects={projects.onSelectAll}
          onClearAllProjects={projects.onClearAll}
          onSaveProjectCombination={projects.onSaveCombination}
          filter={filter}
          onOpenTunnel={onOpenTunnel}
          chatAvailable={toolbar.chatAvailable}
          onOpenChat={toolbar.onOpenChat}
          menu={{
            onRefresh: toolbar.onRefresh,
            isRefreshing: toolbar.isRefreshing,
            onOpenHelp,
            onOpenShortcuts,
            tipsBannerDismissed: tipsBanner.dismissed,
            onShowTipsBanner: tipsBanner.onShow,
          }}
        />
      </ErrorBoundary>
    </header>
  );
}
