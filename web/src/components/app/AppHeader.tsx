import type { ProjectDto } from '../../api';
import type { StreamState } from '../../useBoardStream';
import type {
  BoardFilterPreset,
  BoardFilterPresetState,
  ViewMode,
} from '../../uiPersistedState';
import { BatchRunProgressChip } from '../batch-run/BatchRunProgressChip';
import { ErrorBoundary } from '../ErrorBoundary';
import { GlobalBar } from '../GlobalBar';
import type { NextUpRunLoopController } from '../nextUpRunLoop';
import { ViewToolbar } from '../ViewToolbar';

export interface AppHeaderProps {
  view: ViewMode;
  onViewChange: (view: ViewMode) => void;
  notificationUnreadCount: number;
  onOpenSearch: () => void;
  connection: {
    streamState: StreamState;
    connectStalled: boolean;
    lastContactAtMs: number | null | undefined;
    generatedAt: string | null | undefined;
    lastRefreshAt: string | null | undefined;
  };
  sessions: {
    total: number;
    active: number;
    onOpen: () => void;
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
  onOpenSettings: () => void;
  onOpenTunnel: () => void;
  onOpenHelp: () => void;
  onOpenShortcuts: () => void;
  tipsBanner: {
    dismissed: boolean;
    onShow: () => void;
  };
  toolbar: {
    boardFilterPresets: BoardFilterPreset[];
    onBoardFilterPresetsChange: (presets: BoardFilterPreset[]) => void;
    boardFilterPresetState: BoardFilterPresetState;
    onApplyBoardFilterPreset: (preset: BoardFilterPreset) => void;
    hideDone: boolean;
    onHideDoneChange: (value: boolean) => void;
    stalledOnly: boolean;
    onStalledOnlyChange: (value: boolean) => void;
    onRefresh: () => void;
    isRefreshing: boolean;
    chatAvailable: boolean;
    onOpenChat: () => void;
    presetSaveIntentToken: number;
  };
  /**
   * エージェントの一括実行ループ (App が持つ)。進捗と停止をヘッダーのチップに出す
   * (bdboard-mkm1.2)。ビューを切り替えてもヘッダーは残るので、実行中はどこからでも見える。
   */
  batchRun: NextUpRunLoopController;
}

/**
 * bdboard-62p4 候補1「ヘッダー」。App.tsx の `<header>` 配下
 * (旧 L578-631、GlobalBar/ViewToolbar を ErrorBoundary でラップして値を
 * 橋渡しするだけの JSX) を丸ごと移した表示専用コンポーネント。
 * state・effect は一切ここに移さず App.tsx 側に残す。
 *
 * GlobalBar (26 props) と ViewToolbar (17 props) はどちらも既存の独立
 * コンポーネントで、ここでは変更していない — 渡している値・prop名は
 * 元の App.tsx から1文字も変えていない。呼び出し元 (App.tsx) 側の
 * props 爆発を避けるため、このコンポーネント自体は関心ごとにまとめた
 * オブジェクト (connection/sessions/statusDetail/projects/tipsBanner/
 * toolbar) を受け取り、GlobalBar/ViewToolbar 個別の平たい props へ展開する
 * (AppViewContent.tsx の board/boardMeta/nextUp/windows と同じ手法)。
 *
 * onOpenSessionList は GlobalBar/ViewToolbar 双方で元々
 * `() => handleOpenSessionList()` という「呼び出し側からの引数を捨てて
 * 引数なしで呼ぶ」ラップだった。ここでも `sessions.onOpen` を同じ形で
 * ラップして呼ぶことで、GlobalBar/ViewToolbar 内部が将来 projectId を
 * 渡すように変わっても現状の(常に無引数で呼ぶ)挙動を維持する。
 */
export function AppHeader({
  view,
  onViewChange,
  notificationUnreadCount,
  onOpenSearch,
  connection,
  sessions,
  statusDetail,
  projects,
  onOpenSettings,
  onOpenTunnel,
  onOpenHelp,
  onOpenShortcuts,
  tipsBanner,
  toolbar,
  batchRun,
}: AppHeaderProps) {
  return (
    <header className="header">
      <ErrorBoundary label="ヘッダー">
        <GlobalBar
          view={view}
          onViewChange={onViewChange}
          notificationUnreadCount={notificationUnreadCount}
          onOpenSearch={onOpenSearch}
          streamState={connection.streamState}
          connectStalled={connection.connectStalled}
          lastContactAtMs={connection.lastContactAtMs}
          generatedAt={connection.generatedAt}
          lastRefreshAt={connection.lastRefreshAt}
          totalSessionCount={sessions.total}
          activeSessionCount={sessions.active}
          onOpenSessionList={() => sessions.onOpen()}
          statusDetailOpen={statusDetail.open}
          onStatusDetailOpenChange={statusDetail.onOpenChange}
          projects={projects.list}
          selectedProjectIds={projects.selectedIds}
          onToggleProject={projects.onToggle}
          onSelectAllProjects={projects.onSelectAll}
          onClearAllProjects={projects.onClearAll}
          onSaveProjectCombination={projects.onSaveCombination}
          onOpenSettings={onOpenSettings}
          onOpenTunnel={onOpenTunnel}
          onOpenHelp={onOpenHelp}
          onOpenShortcuts={onOpenShortcuts}
          tipsBannerDismissed={tipsBanner.dismissed}
          onShowTipsBanner={tipsBanner.onShow}
        />
      </ErrorBoundary>

      <ErrorBoundary label="一括実行の進捗">
        <BatchRunProgressChip batchRun={batchRun} />
      </ErrorBoundary>

      <ErrorBoundary label="ツールバー">
        <ViewToolbar
          view={view}
          boardFilterPresets={toolbar.boardFilterPresets}
          onBoardFilterPresetsChange={toolbar.onBoardFilterPresetsChange}
          boardFilterPresetState={toolbar.boardFilterPresetState}
          onApplyBoardFilterPreset={toolbar.onApplyBoardFilterPreset}
          hideDone={toolbar.hideDone}
          onHideDoneChange={toolbar.onHideDoneChange}
          stalledOnly={toolbar.stalledOnly}
          onStalledOnlyChange={toolbar.onStalledOnlyChange}
          totalSessionCount={sessions.total}
          activeSessionCount={sessions.active}
          onOpenSessionList={() => sessions.onOpen()}
          onRefresh={toolbar.onRefresh}
          isRefreshing={toolbar.isRefreshing}
          chatAvailable={toolbar.chatAvailable}
          onOpenChat={toolbar.onOpenChat}
          presetSaveIntentToken={toolbar.presetSaveIntentToken}
        />
      </ErrorBoundary>
    </header>
  );
}
