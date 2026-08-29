import { type BoardDto, type PrBadgeDto, projectNameFallback } from '../api';
import { NEXT_UP_LIMITS, type NextUpLimit } from '../uiPersistedState';
import { CardItem } from './LaneColumn';

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
}: NextUpViewProps) {
  const readyCards = board.lanes.ready ?? [];
  const { regularCards, epicCards } = splitReadyCards(readyCards);
  const visibleRegularCards = regularCards.slice(0, limit);
  const visibleEpicCards = epicCards.slice(0, limit);
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
          <button
            type="button"
            className={`toggle-btn next-up-epic-toggle${showEpics ? ' active' : ''}`}
            aria-pressed={showEpics}
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
          <div className="next-up-cards next-up-epic-cards">
            {renderCardList(visibleEpicCards, cardListProps)}
          </div>
        </div>
      )}
    </section>
  );
}
