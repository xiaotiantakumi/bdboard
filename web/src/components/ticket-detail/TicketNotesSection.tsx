// bdboard-xfi7: notes は「これまでの経緯」として閉じた状態で出す。description が
// 「今みてほしいこと」だけを持ち、経緯は `bd update --append-notes` で notes に
// 日付付きで積む運用に合わせる。件数と最終日は行頭の YYYY-MM-DD から数える
// (日付の無い notes は件数を出さない)。
import { MarkdownContent } from '../MarkdownContent';

const DATED_ENTRY_PATTERN = /^\s*(?:[-*]\s+|#+\s+)?\**(\d{4}-\d{2}-\d{2})/gm;

export function summarizeNotes(notes: string): { count: number; lastDate?: string } {
  const dates = [...notes.matchAll(DATED_ENTRY_PATTERN)].map((match) => match[1]!);
  if (dates.length === 0) return { count: 0 };
  return { count: dates.length, lastDate: [...dates].sort().at(-1) };
}

export interface TicketNotesSectionProps {
  notes: string | undefined;
  isTicketOnBoard: (ticketId: string) => boolean;
  onOpenTicket: (ticketId: string) => void;
}

export function TicketNotesSection({
  notes,
  isTicketOnBoard,
  onOpenTicket,
}: TicketNotesSectionProps) {
  if (notes === undefined) return null;
  const { count, lastDate } = summarizeNotes(notes);
  return (
    <div className="detail-section">
      <details className="ticket-notes-details">
        <summary>
          <h3>これまでの経緯</h3>
          {count > 0 && (
            <span className="detail-help">
              {` ${count} 件・最終 ${lastDate}`}
            </span>
          )}
        </summary>
        <MarkdownContent
          text={notes}
          isTicketOnBoard={isTicketOnBoard}
          onOpenTicket={onOpenTicket}
          className="markdown-detail"
        />
      </details>
    </div>
  );
}
