import type { BoardCardDto, Lane, PrBadgeDto } from '../../api';
import { livenessClass } from '../../liveness';
import { PrLinkBadge } from '../PrLinkBadge';
import {
  deferCountdownClass,
  formatDeferCountdown,
  formatDeferDate,
  priorityBadgeClass,
} from './cardHelpers';
import {
  BlockedIcon,
  DeferIcon,
  PendingDecisionIcon,
  StalledIcon,
  UnblocksIcon,
} from './CardBadgeIcons';

export interface CardBadgesProps {
  card: BoardCardDto;
  lane: Lane;
  hasPendingDecision: boolean;
  prLink?: PrBadgeDto;
  statusMismatch: boolean;
  showDeferCountdown: boolean;
}

export function CardBadges({
  card,
  lane,
  hasPendingDecision,
  prLink,
  statusMismatch,
  showDeferCountdown,
}: CardBadgesProps) {
  const {
    ticket,
    blockedBy,
    unblocksCount,
    sessions,
    liveness,
    deferDays,
    deferUrgency,
    effectivePriority,
    priorityInheritedFrom,
  } = card;

  return (
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
      {/* showDeferCountdown は lane==='blocked' のみ true になる(CardItem 側で判定)。
          deferDays/deferUrgency は showDeferCountdown が true のときだけ non-null という
          不変条件は元のコードと同じだが、コンポーネント境界を越えて渡すと TS の型narrowing が
          追えなくなるため、ここで明示的に再チェックする(挙動は不変)。 */}
      {showDeferCountdown && deferDays !== null && deferUrgency !== null && (
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
  );
}
