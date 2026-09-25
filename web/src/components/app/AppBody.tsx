import { BoardDnDProvider } from '../BoardDnDProvider';
import { BulkSelectionProvider } from '../BulkSelectionProvider';
import { UndoSnackbarProvider } from '../UndoSnackbar';
import { PopoverCoordinatorProvider } from '../PopoverCoordinator';
import { AlertBar } from '../AlertBar';
import { TipsBanner } from '../TipsBanner';
import { AppHeaderSection } from './AppHeaderSection';
import { AppOverlaySection } from './AppOverlaySection';
import { AppViewContent } from './AppViewContent';
import type { useAppController } from './useAppController';

export interface AppBodyProps {
  controller: ReturnType<typeof useAppController>;
}

/**
 * App.tsx の JSX 本体(旧322〜521行目)をそのまま持つ表示専用コンポーネント
 * (bdboard-62p4 第6段)。TicketDetailPanel/TicketDetailBody
 * (bdboard-sso1.5)と同じ「controller hook + presentational body」の分割方針を
 * 踏襲するが、prop の渡し方は精度が異なる: あちらの TicketDetailBody は
 * useTicketDetailController の戻り値を関心事ごとにグループ化した上で
 * (`title`/`agentRun`/`labels` 等)個別の型付き prop として受け取るのに対し、
 * ここでは useAppController の戻り値(約70フィールドのフラットな1オブジェクト)
 * をそのまま単一の `controller` prop として渡す(≤12 props soft guidance に
 * 対し、個々の値を並べると70近い props になるため、フィールド名を変えない
 * 1オブジェクトにまとめて渡す形をとった。関心事ごとのグループ化は将来の
 * 改善余地として残る — bdboard-62p4 の opus レビュー参照)。AppHeader /
 * AppOverlayGroup 呼び出し部分は行数の都合で AppHeaderSection.tsx /
 * AppOverlaySection.tsx へさらに分けた(いずれも同じ `controller` prop を
 * 受け取るだけの表示専用コンポーネント)。それ以外の JSX 自体は分割代入した
 * 変数名も含め元の App.tsx から1文字も変えていない。唯一の例外は
 * hideDone/setHideDone/stalledOnly/setStalledOnly の参照元を
 * `controller.boardFilterState.hideDone` 等に変えた点(useAppController.ts の
 * JSDoc の通り、同じ boardFilterState オブジェクトの中身なので値は変わらない)。
 */
export function AppBody({ controller }: AppBodyProps) {
  const {
    view,
    selectedProjectIds,
    selectedProjectIdsJoined,
    activityWindowDays,
    setActivityWindowDays,
    digestWindowDays,
    setDigestWindowDays,
    statsWeeks,
    setStatsWeeks,
    tipsBannerDismissed,
    setTipsBannerDismissed,
    boardFilterState,
    nextUpBatchRun,
    epicFilterId,
    setEpicFilterId,
    selectedTicketId,
    handleSelectTicket,
    overlays,
    projectNames,
    projectActiveSessions,
    projectRootPaths,
    statusErrors,
    boardQuery,
    availableLabels,
    boardCardsById,
    streamState,
    lastContactAtMs,
    connectStalled,
    pendingDecisionIds,
    prLinksById,
    wipLimitsOverrides,
    notificationEvents,
    handleRefresh,
    isRefreshing,
  } = controller;

  return (
    <UndoSnackbarProvider>
    <PopoverCoordinatorProvider>
    <div className="app">
      <AppHeaderSection controller={controller} />

      <AlertBar
        streamState={streamState}
        lastContactAtMs={lastContactAtMs}
        connectStalled={connectStalled}
        onRefresh={handleRefresh}
        isRefreshing={isRefreshing}
        onOpenDetails={overlays.handleOpenStatusDetail}
      />

      {statusErrors.length > 0 && (
        <div className="header-status-errors error-banner">
          <strong>ステータスエラー ({statusErrors.length} 件)</strong>
          <ul>
            {statusErrors.map((entry, index) => (
              <li key={`${entry.kind}-${entry.projectId}-${index}`}>
                [{entry.kind}] {entry.projectId}: {entry.detail}
              </li>
            ))}
          </ul>
        </div>
      )}

      {!tipsBannerDismissed && (
        <TipsBanner
          onOpenHelp={overlays.handleOpenHelp}
          onDismiss={() => setTipsBannerDismissed(true)}
        />
      )}

      <main className="main">
        {/* プロバイダーは境界の外に置く。中に入れると key={view} の再マウントが
            そのまま伝わり、ビューを往復しただけで一括選択が消える (PR#129 レビュー)。
            context を配るだけの薄い描画なので、境界で守る価値もほぼ無い。 */}
        <BoardDnDProvider>
        <BulkSelectionProvider>
        <AppViewContent
          view={view}
          filterState={boardFilterState}
          epicFilterId={epicFilterId}
          onClearEpicFilter={() => setEpicFilterId(undefined)}
          board={{
            query: boardQuery,
            cardsById: boardCardsById,
            availableLabels,
          }}
          boardMeta={{
            projectNames,
            projectActiveSessions,
            projectRootPaths,
            pendingDecisionIds,
            prLinksById,
            wipLimitsOverrides,
            selectedProjectIds,
            selectedProjectIdsJoined,
          }}
          selectedTicketId={selectedTicketId}
          onCardClick={handleSelectTicket}
          onSessionBadgeClick={overlays.handleOpenSessionList}
          nextUp={{
            batchRun: nextUpBatchRun,
          }}
          windows={{
            activityWindowDays,
            onActivityWindowDaysChange: setActivityWindowDays,
            digestWindowDays,
            onDigestWindowDaysChange: setDigestWindowDays,
            statsWeeks,
            onStatsWeeksChange: setStatsWeeks,
          }}
          notificationEvents={notificationEvents}
        />
        </BulkSelectionProvider>
        </BoardDnDProvider>
      </main>

      <AppOverlaySection controller={controller} />

    </div>
    </PopoverCoordinatorProvider>
    </UndoSnackbarProvider>
  );
}
