// bdboard-sso1.43: NextUpView.tsx のカード一覧描画 (renderCardList) を
// 表示専用コンポーネントとして移動しただけ。state は親に残し、props で
// 値とハンドラを受け取る。JSX・DOM構造は移動前から変えていない。
import {
  type BoardDto,
  type PrBadgeDto,
  projectNameFallback,
} from '../../api';
import { CardItem } from '../LaneColumn';

export interface NextUpCardListProps {
  cards: BoardDto['lanes']['ready'];
  projectNames: Map<string, string>;
  projectActiveSessions: Map<string, number>;
  pendingDecisionIds: ReadonlySet<string>;
  prLinksById: ReadonlyMap<string, PrBadgeDto>;
  onCardClick: (ticketId: string) => void;
}

export function NextUpCardList({
  cards,
  projectNames,
  projectActiveSessions,
  pendingDecisionIds,
  prLinksById,
  onCardClick,
}: NextUpCardListProps) {
  return (
    <>
      {cards.map((card) => (
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
      ))}
    </>
  );
}
