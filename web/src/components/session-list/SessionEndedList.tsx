// bdboard-sso1.38: SessionListPanel.tsx の「終了」タブの <ul> を、JSX/DOM を
// 変えずにこの表示部品へ移した。state を持たない純粋な表示部品。
import type { SessionHistoryEntryDto } from '../../api';
import { formatAbsoluteTime } from '../../formatAbsoluteTime';
import { formatTicketLabel } from './sessionListHelpers';

interface SessionEndedListProps {
  rows: readonly SessionHistoryEntryDto[];
}

export function SessionEndedList({ rows }: SessionEndedListProps) {
  return (
    <ul className="session-list">
      {rows.map((entry) => (
        <li key={entry.session.sessionId} className="session-row">
          <div className="session-row-field">
            <div className="detail-field-label">最終活動</div>
            <div>{formatAbsoluteTime(entry.session.lastActivityAt)}</div>
          </div>
          <div className="session-row-field">
            <div className="detail-field-label">セッション</div>
            <div className="session-row-mono">
              {entry.session.name ?? entry.session.sessionId}
            </div>
            {entry.session.name !== undefined && (
              <div className="session-row-mono session-row-sub-id">
                {entry.session.sessionId}
              </div>
            )}
          </div>
          <div className="session-row-field">
            <div className="detail-field-label">プロジェクト</div>
            <div>{entry.projectName ?? '—'}</div>
          </div>
          <div className="session-row-field">
            <div className="detail-field-label">チケット</div>
            {entry.tickets.length === 0 ? (
              <div>—</div>
            ) : (
              <ul className="session-history-tickets">
                {entry.tickets.map((ticket) => (
                  <li key={ticket.ticketId} className="session-row-mono">
                    {formatTicketLabel(ticket)}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}
