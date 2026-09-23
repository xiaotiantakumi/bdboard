// bdboard-sso1.5: 「Blocked By」「Blocks」の2ブロックが同じ DOM 構造
// (.detail-section > h3 + .detail-list の TicketIdLink 一覧、0件なら非表示)を
// 繰り返していたのをまとめた表示専用コンポーネント。DOM構造・クラス名・
// 0件時に描画しない挙動は移動前の各インラインブロックと同一
// (PR-L調査コメントで見送られていた候補)。
import { TicketIdLink } from './TicketIdLink';

export interface TicketIdListSectionProps {
  heading: string;
  ids: readonly string[];
  isTicketOnBoard: (ticketId: string) => boolean;
  onOpenTicket: (ticketId: string) => void;
}

export function TicketIdListSection({
  heading,
  ids,
  isTicketOnBoard,
  onOpenTicket,
}: TicketIdListSectionProps) {
  if (ids.length === 0) {
    return null;
  }

  return (
    <div className="detail-section">
      <h3>{heading}</h3>
      <ul className="detail-list">
        {ids.map((id) => (
          <li key={id}>
            <TicketIdLink
              id={id}
              isTicketOnBoard={isTicketOnBoard}
              onOpenTicket={onOpenTicket}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}
