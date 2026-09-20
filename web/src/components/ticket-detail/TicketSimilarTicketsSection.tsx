// bdboard-sso1.5 (PR-C): TicketDetailPanel.tsx の「似ているチケット」表示ブロックを
// 移動しただけのコンポーネント。state・query は親(TicketDetailPanel)に残し、
// 値とハンドラを props で受け取る表示専用コンポーネント。JSX・className・
// aria属性・文言・DOM構造は移動前から変えていない。
import type { TicketSimilarResultDto } from '../../api';
import { TicketIdLink } from './TicketIdLink';

export interface TicketSimilarTicketsSectionProps {
  loading: boolean;
  error: Error | null;
  tickets: TicketSimilarResultDto[] | undefined;
  isTicketOnBoard: (ticketId: string) => boolean;
  onOpenTicket: (ticketId: string) => void;
}

export function TicketSimilarTicketsSection({
  loading,
  error,
  tickets,
  isTicketOnBoard,
  onOpenTicket,
}: TicketSimilarTicketsSectionProps) {
  return (
    <div className="detail-section">
      <h3>似ているチケット</h3>
      {loading && <p className="detail-help">読み込み中…</p>}
      {error !== null && (
        <p className="detail-help">似ているチケットの取得に失敗しました。</p>
      )}
      {!loading &&
        error === null &&
        tickets !== undefined &&
        tickets.length === 0 && (
          <p className="detail-help">似ているチケットはありません。</p>
        )}
      {tickets !== undefined && tickets.length > 0 && (
        <ul className="detail-list">
          {tickets.map((similar: TicketSimilarResultDto) => (
            <li key={similar.id}>
              <TicketIdLink
                id={similar.id}
                isTicketOnBoard={isTicketOnBoard}
                onOpenTicket={onOpenTicket}
              />{' '}
              <span>{similar.title}</span>{' '}
              <span className="badge">
                {Math.round(similar.score * 100)}%
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
