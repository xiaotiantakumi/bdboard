import { useEffect, useState } from 'react';
import { LANE_LABELS, projectNameFallback } from '../api';
import { useBoardDnD } from './BoardDnDProvider';
import { useBoardKeyboardNav } from './BoardKeyboardNavProvider';
import { PAGE_SIZE } from './lane/constants';
import { CardItem } from './lane/CardItem';
import type { LaneColumnProps } from './lane/types';

export { CardItem } from './lane/CardItem';
export type { CardItemProps, LaneColumnProps } from './lane/types';

export function LaneColumn({
  lane,
  cards,
  unfilteredCount,
  showProjectName,
  projectNames,
  projectActiveSessions,
  pendingDecisionIds,
  prLinksById,
  onCardClick,
  hiddenCount,
  collapsed = false,
  onToggleCollapse = () => {},
  wipStatus,
}: LaneColumnProps) {
  const boardDnD = useBoardDnD();
  const boardNav = useBoardKeyboardNav();
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const visibleCards = cards.slice(0, visibleCount);
  const visibleCardIds = visibleCards.map((card) => card.ticket.id);
  const idsKey = visibleCardIds.join(',');
  const remaining = cards.length - visibleCount;
  const dropHoverClass =
    boardDnD?.dropHover?.lane === lane
      ? boardDnD.dropHover.allowed
        ? ' lane-drop-allowed'
        : ' lane-drop-rejected'
      : '';

  // registerLane/unregisterLane は provider 側で useCallback により参照安定。
  // boardNav 自体を依存に入れるとフォーカス移動のたびに context 値の identity が
  // 変わり、全レーンが unregister→register を繰り返すので、関数だけを依存にする。
  const registerLane = boardNav?.registerLane;
  const unregisterLane = boardNav?.unregisterLane;

  useEffect(() => {
    if (registerLane === undefined || unregisterLane === undefined) {
      return;
    }
    // idsKey は visibleCardIds の内容キー。内容が同じ間は再登録不要なので、
    // visibleCardIds 自体は依存に入れない(毎レンダー新しい配列になるため)。
    registerLane(lane, collapsed ? [] : visibleCardIds);
    return () => {
      unregisterLane(lane);
    };
  }, [registerLane, unregisterLane, lane, idsKey, collapsed]);

  const showMoreButton =
    remaining > 0 ? (
      <button
        type="button"
        className="btn btn-small show-more-btn"
        onClick={() => setVisibleCount((count) => count + PAGE_SIZE)}
      >
        さらに表示 (残り {remaining} 件)
      </button>
    ) : null;

  const countLabel =
    wipStatus?.exceeded === true
      ? `WIP超過: ${wipStatus.count}/${wipStatus.limit}`
      : unfilteredCount !== undefined && cards.length !== unfilteredCount
        ? `${cards.length}/${unfilteredCount}`
        : String(cards.length);

  const headerAriaLabel =
    wipStatus?.exceeded === true
      ? `${LANE_LABELS[lane]} (WIP超過: ${wipStatus.count}/${wipStatus.limit})`
      : `${LANE_LABELS[lane]} (${countLabel}件)`;

  return (
    <section
      className={`lane${collapsed ? ' lane-collapsed' : ''}${dropHoverClass}`}
      data-lane={lane}
      onDragOver={(event) => boardDnD?.onLaneDragOver(lane, event)}
      onDrop={(event) => boardDnD?.onLaneDrop(lane, event)}
    >
      <button
        type="button"
        className={`lane-header${wipStatus?.exceeded === true ? ' lane-header-wip-exceeded' : ''}`}
        onClick={onToggleCollapse}
        aria-expanded={!collapsed}
        aria-label={headerAriaLabel}
      >
        <span className="lane-header-label">
          <span className="lane-chevron" aria-hidden="true">
            {collapsed ? '▶' : '▼'}
          </span>
          <span className="lane-header-label-text">{LANE_LABELS[lane]}</span>
        </span>
        <span className="lane-count">{countLabel}</span>
      </button>
      {!collapsed && (
        <>
          <div
            className="lane-cards"
            {...(boardNav !== null
              ? {
                  role: 'listbox' as const,
                  'aria-label': `${LANE_LABELS[lane]} のチケット`,
                  'aria-orientation': 'vertical' as const,
                }
              : {})}
          >
            {visibleCards.map((card) => (
              <CardItem
                key={card.ticket.id}
                card={card}
                lane={lane}
                showProjectName={showProjectName}
                projectName={projectNames.get(card.projectId) ?? projectNameFallback(card.projectId)}
                activeSessionCount={projectActiveSessions.get(card.projectId) ?? 0}
                hasPendingDecision={pendingDecisionIds.has(card.ticket.id)}
                prLink={prLinksById.get(card.ticket.id)}
                onClick={onCardClick}
                enableDrag={boardDnD !== null}
                nav={boardNav?.getCardNavProps(lane, card.ticket.id)}
              />
            ))}
          </div>
          {showMoreButton !== null && (
            <div className="lane-show-more">{showMoreButton}</div>
          )}
          {hiddenCount !== undefined && hiddenCount > 0 && (
            <div
              className="lane-hidden-note"
              title="サーバー側の上限を超えた古いチケットは一覧に含まれていません"
            >
              他 {hiddenCount} 件 (非表示)
            </div>
          )}
        </>
      )}
    </section>
  );
}
