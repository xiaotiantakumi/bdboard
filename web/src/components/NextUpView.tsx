import { useCallback, useRef, useState } from 'react';
import { type BoardDto, type PrBadgeDto, projectNameFallback } from '../api';
import { NEXT_UP_LIMITS, type NextUpLimit } from '../uiPersistedState';
import { CardItem } from './LaneColumn';
import {
  type NextUpRunLoopController,
  type NextUpLoopProgress,
} from './nextUpRunLoop';
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
}

function splitReadyCards(readyCards: BoardDto['lanes']['ready']) {
  const regularCards = [];
  const epicCards = [];
  for (const card of readyCards) {
    if (card.ticket.issueType === 'epic') {
      epicCards.push(card);
    } else {
      regularCards.push(card);
    }
  }
  return { regularCards, epicCards };
}

function renderLoopProgressSummary(
  progress: NextUpLoopProgress,
  options?: { prefix?: string; showEndReason?: boolean },
): string {
  const completedPart = `完了 ${progress.completedCount}/${progress.totalCount}`;
  const parts: string[] = [];

  if (options?.prefix !== undefined && options.prefix.length > 0) {
    let header = options.prefix;
    if (options.showEndReason && progress.endReason !== null) {
      const endLabel =
        progress.endReason === 'completed'
          ? '完走'
          : progress.endReason === 'poll_failed'
            ? '中断(状況を確認できず)'
            : '中断';
      header = `${header} ${endLabel}`;
    }
    parts.push(`${header} | ${completedPart}`);
  } else {
    parts.push(completedPart);
  }

  parts.push(`失敗 ${progress.failedCount}`);
  if (progress.cancelledCount > 0) {
    parts.push(`中止 ${progress.cancelledCount}`);
  }
  if (progress.unknownCount > 0) {
    parts.push(`不明 ${progress.unknownCount}`);
  }
  if (options?.showEndReason) {
    let runningCount = 0;
    if (progress.endReason === 'stopped' && progress.currentTicketId !== null) {
      runningCount = 1;
      parts.push(`実行中 ${runningCount}`);
    }
    const remaining =
      progress.totalCount -
      (progress.completedCount +
        progress.failedCount +
        progress.cancelledCount +
        progress.unknownCount +
        runningCount);
    if (remaining > 0) {
      parts.push(`未実行 ${remaining}`);
    }
  }
  return parts.join(' | ');
}

function renderCardList(
  cards: BoardDto['lanes']['ready'],
  props: Pick<
    NextUpViewProps,
    | 'projectNames'
    | 'projectActiveSessions'
    | 'pendingDecisionIds'
    | 'prLinksById'
    | 'onCardClick'
  >,
) {
  const {
    projectNames,
    projectActiveSessions,
    pendingDecisionIds,
    prLinksById,
    onCardClick,
  } = props;

  return cards.map((card) => (
    <CardItem
      key={card.ticket.id}
      card={card}
      lane="ready"
      showProjectName
      projectName={projectNames.get(card.projectId) ?? projectNameFallback(card.projectId)}
      activeSessionCount={projectActiveSessions.get(card.projectId) ?? 0}
      hasPendingDecision={pendingDecisionIds.has(card.ticket.id)}
      prLink={prLinksById.get(card.ticket.id)}
      onClick={onCardClick}
    />
  ));
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
}: NextUpViewProps) {
  const readyCards = board.lanes.ready ?? [];
  const { regularCards, epicCards } = splitReadyCards(readyCards);
  const visibleRegularCards = regularCards.slice(0, limit);
  const visibleEpicCards = epicCards.slice(0, limit);
  const [pendingBatchTicketIds, setPendingBatchTicketIds] = useState<
    readonly string[] | null
  >(null);
  const batchRunConfirmRef = useRef<HTMLDivElement>(null);
  const cancelBatchRunConfirmRef = useRef<HTMLButtonElement>(null);
  const loopPhase = batchRun.phase;
  const loopProgress = batchRun.progress;

  const handleOpenBatchRunConfirm = useCallback(() => {
    if (loopPhase !== 'idle' || visibleRegularCards.length === 0) {
      return;
    }
    setPendingBatchTicketIds(
      visibleRegularCards.map((card) => card.ticket.id),
    );
  }, [loopPhase, visibleRegularCards]);

  const handleCancelBatchRunConfirm = useCallback(() => {
    setPendingBatchTicketIds(null);
  }, []);

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

  const handleConfirmBatchRun = useCallback(() => {
    const ticketIds = pendingBatchTicketIds;
    setPendingBatchTicketIds(null);
    if (ticketIds !== null) {
      batchRun.beginBatchRun(ticketIds);
    }
  }, [batchRun, pendingBatchTicketIds]);

  const handleStopLoop = useCallback(() => {
    // Do not call cancelAgentRun here: the server-side run keeps going.
    // Stopping means the batch loop will not advance to the next ticket and
    // will stop polling progress, returning to idle immediately. To actually
    // cancel the in-flight run, use TicketDetailPanel's per-run cancel button.
    batchRun.stopBatchRun();
  }, [batchRun]);

  const isLoopActive = loopPhase !== 'idle';
  const hasLastRunSummary = !isLoopActive && loopProgress.totalCount > 0;
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
          <div className="next-up-run-group">
            {!isLoopActive ? (
              <button
                type="button"
                className="toggle-btn next-up-run-btn"
                disabled={visibleRegularCards.length === 0}
                onClick={handleOpenBatchRunConfirm}
              >
                ▶ 一括実行
              </button>
            ) : (
              <button
                type="button"
                className="toggle-btn next-up-run-btn next-up-run-btn-stop"
                disabled={loopPhase === 'stopping'}
                onClick={handleStopLoop}
              >
                {loopPhase === 'stopping' ? '■ 停止中…' : '■ 停止'}
              </button>
            )}
            {pendingBatchTicketIds !== null && !isLoopActive && (
              <div
                ref={batchRunConfirmRef}
                className="quick-action-confirm-panel next-up-run-confirm-panel"
                role="alertdialog"
                aria-labelledby="next-up-run-confirm-title"
                aria-describedby="next-up-run-confirm-desc"
              >
                <p
                  id="next-up-run-confirm-title"
                  className="quick-action-confirm-title"
                >
                  一括実行の確認
                </p>
                <p
                  id="next-up-run-confirm-desc"
                  className="quick-action-confirm-desc"
                >
                  表示中の着手可能チケット {pendingBatchTicketIds.length}{' '}
                  件を、上から1件ずつ直列でエージェント実行します。Epic
                  セクションのチケットは対象に含まれません。各チケットごとに
                  worktree の作成（またはクリーンな既存 worktree の再利用）と Claude
                  CLI の起動が走ります。1件が失敗してもループは止まらず次へ進みます。よろしいですか?
                </p>
                <div className="quick-action-confirm-actions">
                  <button
                    ref={cancelBatchRunConfirmRef}
                    type="button"
                    className="btn quick-action-confirm-cancel"
                    onClick={handleCancelBatchRunConfirm}
                  >
                    キャンセル
                  </button>
                  <button
                    type="button"
                    className="btn"
                    onClick={handleConfirmBatchRun}
                  >
                    実行する
                  </button>
                </div>
              </div>
            )}
            {(isLoopActive || hasLastRunSummary) && (
              <>
                <p
                  className="next-up-run-progress"
                  role="status"
                  aria-live="polite"
                >
                  {isLoopActive ? (
                    <>
                      {loopProgress.currentTicketId !== null
                        ? `現在: ${loopProgress.currentTicketId} | `
                        : ''}
                      {renderLoopProgressSummary(loopProgress)}
                    </>
                  ) : (
                    renderLoopProgressSummary(loopProgress, {
                      prefix: '前回の実行:',
                      showEndReason: true,
                    })
                  )}
                </p>
                {loopProgress.lastFailureReason !== null && (
                  <p className="next-up-run-failure-reason error-message">
                    {loopProgress.lastFailureReason}
                  </p>
                )}
                {!isLoopActive && loopProgress.currentTicketId !== null && (
                  <p className="next-up-run-server-active-hint">
                    {loopProgress.currentTicketId}{' '}
                    はサーバー側で実行中の可能性があります
                  </p>
                )}
              </>
            )}
          </div>
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
          {renderCardList(visibleRegularCards, cardListProps)}
        </div>
      )}

      {showEpics && visibleEpicCards.length > 0 && (
        <div className="next-up-epic-section">
          <h3 className="next-up-epic-title">Epic</h3>
          <p className="next-up-epic-note">
            Epic は「▶ 一括実行」の対象外です
          </p>
          <div className="next-up-cards next-up-epic-cards">
            {renderCardList(visibleEpicCards, cardListProps)}
          </div>
        </div>
      )}
    </section>
  );
}
