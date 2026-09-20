import type { DragEvent } from 'react';
import { isLaneStatusMismatch, projectNameFallback } from '../../api';
import { useBoardDnD } from '../BoardDnDProvider';
import { useBulkSelection } from '../BulkSelectionProvider';
import { WatchToggle } from '../WatchToggle';
import { CardBadges } from './CardBadges';
import type { CardItemProps } from './types';

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
  const { ticket, epicProgress, deferDays, deferUrgency } = card;
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
        // カード内のコントロール(ウォッチ★・一括選択チェックボックス・PRリンク)に
        // focus がある状態の Enter/Space まで奪わない。keydown は article まで
        // バブルするので、target がカード自身のときだけ処理する。マウス経路は
        // 各コントロール側の onClick={stopPropagation} で守られているが、keydown
        // 側には同じガードが無く、キーボードだけの利用者は ★ や選択チェックボックスを
        // 操作できず詳細パネルが開くだけだった (bdboard-4dl)。
        if (event.target !== event.currentTarget) {
          return;
        }
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
      <CardBadges
        card={card}
        lane={lane}
        hasPendingDecision={hasPendingDecision}
        prLink={prLink}
        statusMismatch={statusMismatch}
        showDeferCountdown={showDeferCountdown}
      />
    </article>
  );
}
