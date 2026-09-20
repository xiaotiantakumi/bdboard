// bdboard-sso1.38: SessionListPanel.tsx の「稼働中」タブの <ul> を、JSX/DOM を
// 変えずにこの表示部品へ移した。state は親のまま(tailSession は親の useState)、
// テールを開く操作は onOpenTail 経由で親の setTailSession をそのまま呼ぶ。
import type { SessionDto } from '../../api';
import { formatAbsoluteTime } from '../../formatAbsoluteTime';
import { livenessClass, livenessLabel } from '../../liveness';
import type { SessionRow } from './sessionListHelpers';

interface SessionActiveListProps {
  rows: readonly SessionRow[];
  onOpenTail: (session: SessionDto) => void;
}

export function SessionActiveList({ rows, onOpenTail }: SessionActiveListProps) {
  return (
    <ul className="session-list">
      {rows.map((row) => (
        <li key={row.session.sessionId} className="session-row">
          <div className="session-row-field">
            <div className="detail-field-label">プロジェクト</div>
            <div>{row.projectName}</div>
          </div>
          <div className="session-row-field">
            <div className="detail-field-label">セッション ID</div>
            <div className="session-row-mono">{row.session.sessionId}</div>
          </div>
          <div className="session-row-field">
            <div className="detail-field-label">cwd</div>
            <div className="session-row-mono">{row.session.cwd}</div>
          </div>
          <div className="session-row-field">
            <div className="detail-field-label">状態</div>
            <div className="session-row-liveness">
              <span
                className={`liveness-dot ${livenessClass(row.liveness)}`}
              />
              {livenessLabel(row.liveness)}
            </div>
          </div>
          <div className="session-row-field">
            <div className="detail-field-label">開始時刻</div>
            <div>{formatAbsoluteTime(row.session.startedAt)}</div>
          </div>
          <div className="session-row-field">
            <div className="detail-field-label">最終活動</div>
            <div>{formatAbsoluteTime(row.session.lastActivityAt)}</div>
          </div>
          <div className="session-row-meta">
            <span>pid: {row.session.pid}</span>
            {row.session.name !== undefined && (
              <span className="session-row-name">{row.session.name}</span>
            )}
            <button
              type="button"
              className="btn btn-small session-tail-open-btn"
              disabled={row.liveness !== 'active'}
              onClick={() => onOpenTail(row.session)}
              title={
                row.liveness === 'active'
                  ? undefined
                  : 'テールは稼働中のセッションでのみ表示できます'
              }
            >
              テールを見る
            </button>
          </div>
        </li>
      ))}
    </ul>
  );
}
