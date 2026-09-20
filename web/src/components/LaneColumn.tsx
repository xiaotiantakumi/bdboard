import { LANE_LABELS, projectNameFallback } from '../api';
import { useBoardDnD } from './BoardDnDProvider';
import { useBoardKeyboardNav } from './BoardKeyboardNavProvider';
import { CardItem } from './lane/CardItem';
import { useLaneCardPaging } from './lane/useLaneCardPaging';
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
  const { visibleCards, remaining, showMore } = useLaneCardPaging(
    lane,
    cards,
    collapsed,
  );
  const dropHoverClass =
    boardDnD?.dropHover?.lane === lane
      ? boardDnD.dropHover.allowed
        ? ' lane-drop-allowed'
        : ' lane-drop-rejected'
      : '';

  const showMoreButton =
    remaining > 0 ? (
      <button
        type="button"
        className="btn btn-small show-more-btn"
        onClick={showMore}
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
