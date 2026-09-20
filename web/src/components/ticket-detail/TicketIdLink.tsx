// bdboard-sso1.5: TicketDetailPanel.tsx から自己完結した表示専用コンポーネントを
// 移動しただけのファイル。挙動は一切変えていない。
interface TicketIdLinkProps {
  id: string;
  isTicketOnBoard: (ticketId: string) => boolean;
  onOpenTicket: (ticketId: string) => void;
}

export function TicketIdLink({ id, isTicketOnBoard, onOpenTicket }: TicketIdLinkProps) {
  if (isTicketOnBoard(id)) {
    return (
      <button
        type="button"
        className="ticket-id-link"
        onClick={() => onOpenTicket(id)}
      >
        {id}
      </button>
    );
  }

  return (
    <span className="ticket-id-unavailable" title="現在のボードに表示されていません">
      {id}
    </span>
  );
}
