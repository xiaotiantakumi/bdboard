// bdboard-sso1.5 (PR-H): TicketDetailPanel.tsx の「子チケット」表示ブロックを
// 移動しただけのコンポーネント。state・mutation は元から無い(純粋な
// プレゼンテーショナルコンポーネント)。JSX・className・文言・DOM構造は
// 移動前から変えていない。
import type { TicketChildDto } from '../../api';
import { LANE_LABELS } from '../../api';
import { TicketIdLink } from './TicketIdLink';

export interface TicketChildrenSectionProps {
  children: TicketChildDto[];
  isTicketOnBoard: (ticketId: string) => boolean;
  onOpenTicket: (ticketId: string) => void;
  onFilterByEpic: () => void;
}

export function TicketChildrenSection({
  children,
  isTicketOnBoard,
  onOpenTicket,
  onFilterByEpic,
}: TicketChildrenSectionProps) {
  if (children.length === 0) {
    return null;
  }

  return (
    <div className="detail-section">
      <h3>子チケット</h3>
      <ul className="detail-list">
        {children.map((child) => (
          <li key={child.id}>
            <TicketIdLink
              id={child.id}
              isTicketOnBoard={isTicketOnBoard}
              onOpenTicket={onOpenTicket}
            />{' '}
            <span>{child.title}</span>{' '}
            <span className="badge">{LANE_LABELS[child.lane]}</span>
          </li>
        ))}
      </ul>
      <button type="button" className="btn btn-small" onClick={onFilterByEpic}>
        このエピックのみ表示
      </button>
    </div>
  );
}
