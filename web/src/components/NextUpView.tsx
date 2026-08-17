import { type BoardDto, projectNameFallback } from '../api';
import { NEXT_UP_LIMITS, type NextUpLimit } from '../uiPersistedState';
import { CardItem } from './LaneColumn';

export interface NextUpViewProps {
  board: BoardDto;
  limit: NextUpLimit;
  onLimitChange: (limit: NextUpLimit) => void;
  projectNames: Map<string, string>;
  projectActiveSessions: Map<string, number>;
  pendingDecisionIds: ReadonlySet<string>;
  onCardClick: (ticketId: string) => void;
}

export function NextUpView({
  board,
  limit,
  onLimitChange,
  projectNames,
  projectActiveSessions,
  pendingDecisionIds,
  onCardClick,
}: NextUpViewProps) {
  const readyCards = board.lanes.ready ?? [];
  const visibleCards = readyCards.slice(0, limit);

  return (
    <section className="next-up-view" aria-label="Next Up">
      <div className="next-up-header">
        <h2 className="next-up-title">次にやること</h2>
        <div className="next-up-limit-group">
          <span className="header-label">表示件数</span>
          <div className="toggle-group">
            {NEXT_UP_LIMITS.map((option) => (
              <button
                key={option}
                type="button"
                className={`toggle-btn${limit === option ? ' active' : ''}`}
                onClick={() => onLimitChange(option)}
              >
                {option}
              </button>
            ))}
          </div>
        </div>
      </div>

      {visibleCards.length === 0 ? (
        <p className="empty-message">着手できるチケットはありません</p>
      ) : (
        <div className="next-up-cards">
          {visibleCards.map((card) => (
            <CardItem
              key={card.ticket.id}
              card={card}
              lane="ready"
              showProjectName
              projectName={
                projectNames.get(card.projectId) ?? projectNameFallback(card.projectId)
              }
              activeSessionCount={projectActiveSessions.get(card.projectId) ?? 0}
              hasPendingDecision={pendingDecisionIds.has(card.ticket.id)}
              onClick={onCardClick}
            />
          ))}
        </div>
      )}
    </section>
  );
}
