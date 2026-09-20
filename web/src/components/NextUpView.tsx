import {
  type BoardDto,
  type PrBadgeDto,
  type ProjectHarnessStatusDto,
} from '../api';
import { NEXT_UP_LIMITS, type NextUpLimit } from '../uiPersistedState';
import { NextUpBatchRunControls } from './next-up/NextUpBatchRunControls';
import { NextUpCardList } from './next-up/NextUpCardList';
import { splitReadyCards } from './next-up/nextUpHelpers';
import { useNextUpBatchRun } from './next-up/useNextUpBatchRun';
import { type NextUpRunLoopController } from './nextUpRunLoop';
import { togglePressedProps } from './toggleGroupA11y';
import { useFocusTrap } from '../hooks/useFocusTrap';

export interface NextUpViewProps {
  board: BoardDto;
  limit: NextUpLimit;
  onLimitChange: (limit: NextUpLimit) => void;
  showEpics: boolean;
  onShowEpicsChange: (show: boolean) => void;
  projectNames: Map<string, string>;
  projectActiveSessions: Map<string, number>;
  pendingDecisionIds: ReadonlySet<string>;
  prLinksById: ReadonlyMap<string, PrBadgeDto>;
  onCardClick: (ticketId: string) => void;
  batchRun: NextUpRunLoopController;
  /**
   * 一括実行の前提 (ハーネス注入・hook 登録・検証コントラクト) を見るための
   * プロジェクト別ハーネス状態 (bdboard-pkr6.11)。未取得のプロジェクトは
   * 「不明」であって「不備」ではないので、載っていなければ止めない。
   */
  harnessStatuses?: ReadonlyMap<string, ProjectHarnessStatusDto>;
}

export function NextUpView({
  board,
  limit,
  onLimitChange,
  showEpics,
  onShowEpicsChange,
  projectNames,
  projectActiveSessions,
  pendingDecisionIds,
  prLinksById,
  onCardClick,
  batchRun,
  harnessStatuses,
}: NextUpViewProps) {
  const readyCards = board.lanes.ready ?? [];
  const { regularCards, epicCards } = splitReadyCards(readyCards);
  const visibleRegularCards = regularCards.slice(0, limit);
  const visibleEpicCards = epicCards.slice(0, limit);

  const {
    loopPhase,
    loopProgress,
    harnessBlockReason,
    pendingBatchTicketIds,
    batchRunConfirmRef,
    cancelBatchRunConfirmRef,
    handleOpenBatchRunConfirm,
    handleCancelBatchRunConfirm,
    handleConfirmBatchRun,
    handleStopLoop,
  } = useNextUpBatchRun({
    visibleRegularCards,
    projectNames,
    harnessStatuses,
    batchRun,
  });

  // 他の role="alertdialog" (TicketDetailPanel の quick-action / agent-run 確認)
  // と同じく useFocusTrap を通す。フォーカスを閉じ込めないと、確認を出したまま
  // 背後の「▶ 一括実行」や表示件数トグルへ Tab で戻れてしまい、alertdialog を
  // 名乗っている意味が無くなる。初期フォーカスは破壊側ではなくキャンセル側に
  // 置く (TicketDetailPanel の cancelAgentRunConfirmRef と同じ)。
  useFocusTrap({
    containerRef: batchRunConfirmRef,
    initialFocusRef: cancelBatchRunConfirmRef,
    enabled: pendingBatchTicketIds !== null,
    onEscape: handleCancelBatchRunConfirm,
  });

  const cardListProps = {
    projectNames,
    projectActiveSessions,
    pendingDecisionIds,
    prLinksById,
    onCardClick,
  };
  const epicToggleLabel =
    epicCards.length > 0 ? `epic を表示 (${epicCards.length})` : 'epic を表示';

  return (
    <section className="next-up-view" aria-label="Next Up">
      <div className="next-up-header">
        <h2 className="next-up-title">次にやること</h2>
        <div className="next-up-controls">
          <NextUpBatchRunControls
            loopPhase={loopPhase}
            loopProgress={loopProgress}
            harnessBlockReason={harnessBlockReason}
            hasVisibleRegularCards={visibleRegularCards.length > 0}
            pendingBatchTicketIds={pendingBatchTicketIds}
            batchRunConfirmRef={batchRunConfirmRef}
            cancelBatchRunConfirmRef={cancelBatchRunConfirmRef}
            onOpenConfirm={handleOpenBatchRunConfirm}
            onStopLoop={handleStopLoop}
            onCancelConfirm={handleCancelBatchRunConfirm}
            onConfirmRun={handleConfirmBatchRun}
          />
          <div className="next-up-limit-group">
            <span className="header-label">表示件数</span>
            <div className="toggle-group">
              {NEXT_UP_LIMITS.map((option) => (
                <button
                  key={option}
                  type="button"
                  className={`toggle-btn${limit === option ? ' active' : ''}`}
                  {...togglePressedProps(limit === option)}
                  onClick={() => onLimitChange(option)}
                >
                  {option}
                </button>
              ))}
            </div>
          </div>
          <button
            type="button"
            className={`toggle-btn next-up-epic-toggle${showEpics ? ' active' : ''}`}
            {...togglePressedProps(showEpics)}
            onClick={() => onShowEpicsChange(!showEpics)}
          >
            {epicToggleLabel}
          </button>
        </div>
      </div>

      {visibleRegularCards.length === 0 ? (
        <p className="empty-message">着手できるチケットはありません</p>
      ) : (
        <div className="next-up-cards">
          <NextUpCardList cards={visibleRegularCards} {...cardListProps} />
        </div>
      )}

      {showEpics && visibleEpicCards.length > 0 && (
        <div className="next-up-epic-section">
          <h3 className="next-up-epic-title">Epic</h3>
          <p className="next-up-epic-note">
            Epic は「▶ 一括実行」の対象外です
          </p>
          <div className="next-up-cards next-up-epic-cards">
            <NextUpCardList cards={visibleEpicCards} {...cardListProps} />
          </div>
        </div>
      )}
    </section>
  );
}
