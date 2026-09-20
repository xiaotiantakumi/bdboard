// bdboard-sso1.5 (PR-J): TicketDetailPanel.tsx の「セッションリンク」表示・
// 編集ブロックを移動しただけのコンポーネント。state・query・mutation は
// useTicketSessionLink (親で呼び出し) に残し、値とハンドラを props で受け取る
// 表示専用コンポーネント。JSX・className・aria属性・文言・DOM構造は移動前
// から変えていない。
import type { SessionDto, TicketSessionLinkDto } from '../../api';
import { describeWriteError } from '../../writeAccessMessage';
import { PlatformLimitationNotice } from '../PlatformLimitationNotice';
import {
  formatSessionPickerLabel,
  sessionLinkBadgeClass,
  sessionLinkBadgeLabel,
} from './formatters';

export interface TicketSessionLinkSectionProps {
  sessionLinks: TicketSessionLinkDto[];
  pickerOpen: boolean;
  onTogglePicker: () => void;
  isLoadingSessions: boolean;
  activeSessionCandidates: SessionDto[];
  mutationPending: boolean;
  mutationError: unknown;
  onLinkSession: (sessionId: string) => void;
  onUnlinkSession: () => void;
}

export function TicketSessionLinkSection({
  sessionLinks,
  pickerOpen,
  onTogglePicker,
  isLoadingSessions,
  activeSessionCandidates,
  mutationPending,
  mutationError,
  onLinkSession,
  onUnlinkSession,
}: TicketSessionLinkSectionProps) {
  return (
    <div className="detail-section">
      <h3>セッションリンク</h3>
      {sessionLinks.length === 0 && (
        <p className="detail-help">リンクされたセッションはありません</p>
      )}
      {sessionLinks.length > 0 && (
        <ul className="session-link-list">
          {sessionLinks.map((link) => (
            <li key={link.sessionId} className="session-link-item">
              <span className={`badge ${sessionLinkBadgeClass(link.source)}`}>
                {sessionLinkBadgeLabel(link.source)}
              </span>
              <span className="session-link-id">{link.sessionId}</span>
              {link.source === 'metadata' && (
                <button
                  type="button"
                  className="btn session-link-unlink-btn"
                  disabled={mutationPending}
                  aria-label={`${link.sessionId} のリンクを解除`}
                  onClick={onUnlinkSession}
                >
                  解除
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      <button
        type="button"
        className="btn session-link-picker-toggle-btn"
        disabled={mutationPending}
        onClick={onTogglePicker}
      >
        {pickerOpen ? '閉じる' : 'セッションをリンク'}
      </button>
      {pickerOpen && (
        <>
          <p className="detail-help">
            稼働中セッションから選択します(既存の手動リンクは上書きされます)
          </p>
          {/* win32 ではセッション検出そのものが動かないため、ここは
              常に空になる。理由を出さないと「稼働中のセッションが
              ありません」が壊れているようにしか読めない
              (bdboard-70z.9, PR#115 fable レビュー minor)。 */}
          <PlatformLimitationNotice feature="session-discovery" />
          {isLoadingSessions && <p className="loading">読み込み中…</p>}
          {!isLoadingSessions && activeSessionCandidates.length === 0 && (
            <p className="detail-help">稼働中のセッションがありません</p>
          )}
          {activeSessionCandidates.length > 0 && (
            <ul className="dependency-suggestions">
              {activeSessionCandidates.map((session) => (
                <li key={session.sessionId}>
                  <button
                    type="button"
                    className="dependency-suggestion-btn"
                    disabled={mutationPending}
                    onClick={() => onLinkSession(session.sessionId)}
                  >
                    <span className="dependency-suggestion-id">
                      {session.sessionId}
                    </span>
                    <span className="dependency-suggestion-title">
                      {formatSessionPickerLabel(session)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {mutationError !== null && (
        <p className="error-message">
          {describeWriteError(
            mutationError,
            'セッションリンクの更新に失敗しました',
          )}
        </p>
      )}
    </div>
  );
}
