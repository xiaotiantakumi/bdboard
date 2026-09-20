// bdboard-sso1.5 (PR-C): TicketDetailPanel.tsx の「衝突しうる着手中チケット」表示
// ブロックを移動しただけのコンポーネント。state・query は親(TicketDetailPanel)に
// 残し、値とハンドラを props で受け取る表示専用コンポーネント。JSX・className・
// aria属性・文言・DOM構造は移動前から変えていない。
import type { TicketInFlightOverlapDto } from '../../api';
import { OVERLAP_FILE_DISPLAY_LIMIT } from './constants';
import { TicketIdLink } from './TicketIdLink';

export interface TicketInFlightOverlapsSectionProps {
  enabled: boolean;
  error: Error | null;
  overlaps: TicketInFlightOverlapDto[] | undefined;
  isTicketOnBoard: (ticketId: string) => boolean;
  onOpenTicket: (ticketId: string) => void;
}

export function TicketInFlightOverlapsSection({
  enabled,
  error,
  overlaps,
  isTicketOnBoard,
  onOpenTicket,
}: TicketInFlightOverlapsSectionProps) {
  return (
    <>
      {enabled && error !== null && (
        <div className="detail-section">
          <h3>衝突しうる着手中チケット</h3>
          <p className="detail-help">重複チェックを実行できませんでした。</p>
        </div>
      )}
      {/*
        読み込み中は何も出さない。見出しだけ先に出して直後に消える
        (重複が無ければ節ごと消える) と、開くたびに画面が跳ねる。
      */}
      {enabled &&
        error === null &&
        overlaps !== undefined &&
        overlaps.length > 0 && (
          <div className="detail-section">
            <h3>衝突しうる着手中チケット</h3>
            <p className="detail-help">
              同じファイルを編集中の着手中チケットです。どちらかへ寄せるか、
              マージの順番を先に決めてください。
            </p>
            <ul className="detail-list">
              {overlaps.map((overlap: TicketInFlightOverlapDto) => {
                const shownFiles = overlap.files.slice(
                  0,
                  OVERLAP_FILE_DISPLAY_LIMIT,
                );
                const hiddenFileCount = overlap.files.length - shownFiles.length;
                return (
                  <li key={overlap.ticketId}>
                    <TicketIdLink
                      id={overlap.ticketId}
                      isTicketOnBoard={isTicketOnBoard}
                      onOpenTicket={onOpenTicket}
                    />{' '}
                    <span className="badge">{overlap.files.length} ファイル</span>
                    <ul className="detail-list">
                      {shownFiles.map((file) => (
                        <li key={file}>
                          <code>{file}</code>
                        </li>
                      ))}
                      {hiddenFileCount > 0 && (
                        <li className="detail-help">ほか {hiddenFileCount} 件</li>
                      )}
                    </ul>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
    </>
  );
}
