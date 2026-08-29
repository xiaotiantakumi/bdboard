import { useEffect, useState, type DragEvent } from 'react';
import {
  type BoardCardDto,
  isLaneStatusMismatch,
  type Lane,
  LANE_LABELS,
  type PrBadgeDto,
  projectNameFallback,
} from '../api';
import { livenessClass } from '../liveness';
import { useBoardDnD } from './BoardDnDProvider';
import {
  type CardNavProps,
  useBoardKeyboardNav,
} from './BoardKeyboardNavProvider';
import { localDateKey } from './activityFeedFormatting';
import { PrLinkBadge } from './PrLinkBadge';
import { WatchToggle } from './WatchToggle';
import { useBulkSelection } from './BulkSelectionProvider';

export interface CardItemProps {
  card: BoardCardDto;
  lane: Lane;
  showProjectName: boolean;
  projectName: string;
  activeSessionCount: number;
  hasPendingDecision: boolean;
  prLink?: PrBadgeDto;
  onClick: (ticketId: string) => void;
  enableDrag?: boolean;
  nav?: CardNavProps;
}

function priorityBadgeClass(priority: number): string {
  if (priority === 0) return 'badge-p0';
  if (priority === 1) return 'badge-p1';
  if (priority === 2) return 'badge-p2';
  if (priority === 3) return 'badge-p3';
  return 'badge-p4';
}

function formatDeferDate(deferUntil: string): string {
  // ISO 文字列を slice(0, 10) すると UTC の日付になる。defer は UI 側が
  // ローカル日付で送り、bd が「その日のローカル深夜」の UTC 瞬間として持つので
  // (JST なら …T15:00:00Z)、素朴に切ると常に1日前を表示していた (bdboard-ol9)。
  // 日付境界は host TZ ではなく Asia/Tokyo に固定して求める — CI は UTC で
  // 走るので、ローカル TZ に頼ると環境で結果が変わる (bdboard-3tw.75)。
  // 既存の localDateKey に寄せる。日本に DST が無い以上 +9h の手書きでも
  // 結果は同じだが、オフセット算術を各所で手書きしないのがこのファイル群の方針。
  return localDateKey(new Date(deferUntil));
}

function BlockedIcon() {
  return (
    <svg className="badge-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="6.25" stroke="currentColor" strokeWidth="1.4" />
      <line x1="4.2" y1="4.2" x2="11.8" y2="11.8" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

function UnblocksIcon() {
  return (
    <svg className="badge-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect
        x="4"
        y="7.25"
        width="8"
        height="5.5"
        rx="1.3"
        stroke="currentColor"
        strokeWidth="1.4"
      />
      <path
        d="M6 7.25V5.5a2 2 0 0 1 3.6-1.2"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

function DeferIcon() {
  return (
    <svg className="badge-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect
        x="2.5"
        y="3.5"
        width="11"
        height="10"
        rx="1.6"
        stroke="currentColor"
        strokeWidth="1.4"
      />
      <line x1="2.5" y1="6.5" x2="13.5" y2="6.5" stroke="currentColor" strokeWidth="1.4" />
      <line x1="5.5" y1="2" x2="5.5" y2="4.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <line x1="10.5" y1="2" x2="10.5" y2="4.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function StalledIcon() {
  return (
    <svg className="badge-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M8 2.5 13.5 12.5H2.5L8 2.5Z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <line x1="8" y1="6.5" x2="8" y2="9.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <circle cx="8" cy="11.25" r="0.75" fill="currentColor" />
    </svg>
  );
}

function PendingDecisionIcon() {
  return (
    <svg className="badge-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M3.5 3.5h9a1.2 1.2 0 0 1 1.2 1.2v5.1a1.2 1.2 0 0 1-1.2 1.2H6.2L3.8 13.1V4.7a1.2 1.2 0 0 1 1.2-1.2Z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <circle cx="6.2" cy="7.2" r="0.7" fill="currentColor" />
      <circle cx="8" cy="7.2" r="0.7" fill="currentColor" />
      <circle cx="9.8" cy="7.2" r="0.7" fill="currentColor" />
    </svg>
  );
}

function formatDeferCountdown(
  deferDays: number,
  deferUrgency: BoardCardDto['deferUrgency'],
): string {
  if (deferUrgency === 'overdue' || deferDays < 0) {
    return '期限超過';
  }
  if (deferUrgency === 'today' || deferDays === 0) {
    return '今日';
  }
  return `あと${deferDays}日`;
}

function deferCountdownClass(deferUrgency: BoardCardDto['deferUrgency']): string {
  switch (deferUrgency) {
    case 'overdue':
      return 'badge badge-defer-countdown badge-defer-overdue';
    case 'today':
    case 'soon':
      return 'badge badge-defer-countdown badge-defer-soon';
    default:
      return 'badge badge-defer-countdown';
  }
}

export function CardItem({
  card,
  lane,
  showProjectName,
  projectName,
  activeSessionCount,
  hasPendingDecision,
  prLink,
  onClick,
  enableDrag = false,
  nav,
}: CardItemProps) {
  const boardDnD = useBoardDnD();
  const bulkSelection = useBulkSelection();
  const {
    ticket,
    blockedBy,
    unblocksCount,
    sessions,
    liveness,
    epicProgress,
    deferDays,
    deferUrgency,
    effectivePriority,
    priorityInheritedFrom,
  } = card;
  const bulkSelected =
    bulkSelection !== null && bulkSelection.isSelected(ticket.id);
  const statusMismatch = isLaneStatusMismatch(lane, ticket.status);
  const showEpicProgress =
    epicProgress !== null && epicProgress.total > 0;
  // bdboard-662: 保留(deferred)はブロックレーンへ表示統合された。カウントダウン表示は
  // lane === 'blocked' に切り替えて維持する(deferDays/deferUrgency は保留チケットのみ
  // non-null になるため、依存関係由来のブロックカードには出ない)。
  const showDeferCountdown =
    lane === 'blocked' &&
    deferDays !== null &&
    deferUrgency !== null;
  const isDragging =
    enableDrag &&
    boardDnD?.dragging?.ticketId === ticket.id &&
    boardDnD.dragging.sourceLane === lane;

  const handleClick = () => {
    if (boardDnD?.suppressClickRef.current === true) {
      return;
    }
    onClick(ticket.id);
  };

  const handleDragStart = (event: DragEvent<HTMLElement>) => {
    boardDnD?.onCardDragStart(
      { ticketId: ticket.id, sourceLane: lane },
      event,
    );
  };

  return (
    <article
      className={`card${isDragging ? ' card-dragging' : ''}${bulkSelected ? ' card-bulk-selected' : ''}`}
      title={ticket.title}
      draggable={enableDrag && boardDnD !== null}
      onClick={handleClick}
      onDragStart={handleDragStart}
      onDragEnd={() => boardDnD?.onCardDragEnd()}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          handleClick();
        }
      }}
      role={nav !== undefined ? 'option' : 'button'}
      tabIndex={nav?.tabIndex ?? 0}
      aria-selected={nav?.ariaSelected}
      ref={nav?.cardRef}
      onFocus={nav?.onFocus}
    >
      {bulkSelection !== null && (
        <label
          className="card-bulk-checkbox"
          onClick={(event) => event.stopPropagation()}
        >
          <input
            type="checkbox"
            checked={bulkSelected}
            aria-label={`${ticket.id} を選択`}
            onChange={() => bulkSelection.toggle(ticket.id)}
            onClick={(event) => event.stopPropagation()}
          />
        </label>
      )}
      <div className="card-title-row">
        <h4 className="card-title">{ticket.title}</h4>
        <WatchToggle ticketId={ticket.id} className="card-watch-toggle" />
      </div>
      <div className="card-id">{ticket.id}</div>
      {showEpicProgress && (
        <div className="epic-progress">
          <div className="epic-progress-label">
            <span>子チケット</span>
            <span>
              {epicProgress.done}/{epicProgress.total}
            </span>
          </div>
          <div
            className="epic-progress-bar"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={epicProgress.total}
            aria-valuenow={epicProgress.done}
            aria-label={`子チケット ${epicProgress.done}/${epicProgress.total} 完了`}
          >
            <div
              className="epic-progress-fill"
              style={{
                width: `${(epicProgress.done / epicProgress.total) * 100}%`,
              }}
            />
          </div>
        </div>
      )}
      {showProjectName && (
        <div className="card-project">
          {projectName || projectNameFallback(card.projectId)}
          {activeSessionCount > 0 && (
            <span className="session-badge" title="稼働中セッション数">
              ● {activeSessionCount}
            </span>
          )}
        </div>
      )}
      <div className="card-badges">
        <span className={`badge ${priorityBadgeClass(ticket.priority)}`}>
          P{ticket.priority}
        </span>
        {priorityInheritedFrom !== null && (
          <span
            className={`badge badge-priority-inherited ${priorityBadgeClass(effectivePriority)}`}
            title={priorityInheritedFrom}
          >
            P{ticket.priority}→P{effectivePriority}
          </span>
        )}
        {statusMismatch && (
          <span
            className="badge badge-status-mismatch"
            title={`レーン ${lane} と生status ${ticket.status} が食い違っています`}
          >
            status: {ticket.status}
          </span>
        )}
        {card.stalled && (
          <span
            className="badge badge-stalled"
            title="丸一日以上更新が無く、動いているセッションもありません"
          >
            <StalledIcon />
            滞留
          </span>
        )}
        {hasPendingDecision && (
          <span className="badge badge-pending-decision" title="ユーザー確認待ち">
            <PendingDecisionIcon />
            確認待ち
          </span>
        )}
        {(ticket.labels ?? []).map((label) => (
          <span key={label} className="badge badge-label">
            {label}
          </span>
        ))}
        <PrLinkBadge prLink={prLink} />
        {blockedBy.length > 0 && (
          <span className="badge badge-blocked">
            <BlockedIcon />
            blocked by {blockedBy.length}
          </span>
        )}
        {unblocksCount > 0 && (
          <span className="badge badge-unblocks">
            <UnblocksIcon />
            unblocks {unblocksCount}
          </span>
        )}
        {ticket.deferUntil !== undefined && (
          <span className="badge badge-defer">
            <DeferIcon />
            {formatDeferDate(ticket.deferUntil)}
          </span>
        )}
        {showDeferCountdown && (
          <span className={deferCountdownClass(deferUrgency)}>
            {formatDeferCountdown(deferDays, deferUrgency)}
          </span>
        )}
        {sessions.length > 0 && (
          <span className="badge">
            <span className={`liveness-dot ${livenessClass(liveness)}`} />
            {sessions.length} session{sessions.length > 1 ? 's' : ''}
          </span>
        )}
      </div>
    </article>
  );
}

export interface LaneColumnProps {
  lane: Lane;
  cards: BoardCardDto[];
  /** stalledOnly 適用後・board filter 適用前の件数(filtered/total 表示用) */
  unfilteredCount?: number;
  showProjectName: boolean;
  projectNames: Map<string, string>;
  projectActiveSessions: Map<string, number>;
  pendingDecisionIds: ReadonlySet<string>;
  prLinksById: ReadonlyMap<string, PrBadgeDto>;
  onCardClick: (ticketId: string) => void;
  /**
   * サーバー側のclosedLimitで切り捨てられ、このレーンに一切届いていないカード数
   * (doneレーンのみ意味を持つ; bdboard-3tw.86)。0またはundefinedなら非表示。
   */
  hiddenCount?: number;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  /** in_progress レーンの WIP 状態。exceeded 時にヘッダー警告を表示する。 */
  wipStatus?: { limit: number; count: number; exceeded: boolean };
}

const PAGE_SIZE = 50;

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
          <span>{LANE_LABELS[lane]}</span>
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
