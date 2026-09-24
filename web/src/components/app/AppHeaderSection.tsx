import { AppHeader } from './AppHeader';
import type { useAppController } from './useAppController';

export interface AppHeaderSectionProps {
  controller: ReturnType<typeof useAppController>;
}

/**
 * App.tsx の JSX 本体のうち AppHeader 呼び出し部分(旧326〜378行目)を切り出した
 * 表示専用コンポーネント(bdboard-62p4 第6段、AppBody.tsx から分離 —
 * AppBody.tsx 単体で200行に収まらなかったため)。JSX 自体は1文字も
 * 変えていない。
 */
export function AppHeaderSection({ controller }: AppHeaderSectionProps) {
  const {
    view,
    setView,
    notificationEvents,
    overlays,
    streamState,
    connectStalled,
    lastContactAtMs,
    boardQuery,
    lastRefreshAt,
    totalSessionCount,
    activeSessionCount,
    projectsQuery,
    selectedProjectIds,
    handleToggleProject,
    handleSelectAll,
    handleClearAll,
    tipsBannerDismissed,
    setTipsBannerDismissed,
    boardFilterPresets,
    setBoardFilterPresets,
    boardFilterPresetState,
    handleApplyBoardFilterPreset,
    boardFilterState,
    handleRefresh,
    isRefreshing,
    chatAvailable,
  } = controller;

  return (
    <AppHeader
      view={view}
      onViewChange={setView}
      notificationUnreadCount={notificationEvents.unreadCount}
      onOpenSearch={overlays.handleOpenSearch}
      connection={{
        streamState,
        connectStalled,
        lastContactAtMs,
        generatedAt: boardQuery.data?.generatedAt,
        lastRefreshAt,
      }}
      sessions={{
        total: totalSessionCount,
        active: activeSessionCount,
        onOpen: overlays.handleOpenSessionList,
      }}
      statusDetail={{
        open: overlays.statusDetailOpen,
        onOpenChange: overlays.setStatusDetailOpen,
      }}
      projects={{
        list: projectsQuery.data ?? [],
        selectedIds: selectedProjectIds,
        onToggle: handleToggleProject,
        onSelectAll: handleSelectAll,
        onClearAll: handleClearAll,
        onSaveCombination: overlays.handleSaveProjectCombination,
      }}
      onOpenSettings={() => setView('settings')}
      onOpenTunnel={overlays.handleOpenTunnel}
      onOpenHelp={overlays.handleOpenHelp}
      onOpenShortcuts={overlays.handleOpenShortcuts}
      tipsBanner={{
        dismissed: tipsBannerDismissed,
        onShow: () => setTipsBannerDismissed(false),
      }}
      toolbar={{
        boardFilterPresets,
        onBoardFilterPresetsChange: setBoardFilterPresets,
        boardFilterPresetState,
        onApplyBoardFilterPreset: handleApplyBoardFilterPreset,
        hideDone: boardFilterState.hideDone,
        onHideDoneChange: boardFilterState.setHideDone,
        stalledOnly: boardFilterState.stalledOnly,
        onStalledOnlyChange: boardFilterState.setStalledOnly,
        onRefresh: handleRefresh,
        isRefreshing,
        chatAvailable,
        onOpenChat: overlays.handleOpenChat,
        presetSaveIntentToken: overlays.presetSaveIntentToken,
      }}
    />
  );
}
