// bdboard-sso1.38: SessionListPanel.tsx の「プロセス」タブの <ul> を、JSX/DOM を
// 変えずにこの表示部品へ移した。state を持たない純粋な表示部品。
import type { AgentProcessDto } from '../../api';
import { formatAbsoluteTime } from '../../formatAbsoluteTime';
import { processProjectLabel } from './sessionListHelpers';

interface SessionProcessListProps {
  rows: readonly AgentProcessDto[];
}

export function SessionProcessList({ rows }: SessionProcessListProps) {
  return (
    <ul className="session-list">
      {rows.map((process) => (
        <li key={process.pid} className="session-row">
          <div className="session-row-field">
            <div className="detail-field-label">コマンド</div>
            <div className="session-row-mono">{process.command}</div>
          </div>
          <div className="session-row-field">
            <div className="detail-field-label">pid</div>
            <div>{process.pid}</div>
          </div>
          <div className="session-row-field">
            <div className="detail-field-label">プロジェクト</div>
            <div>{processProjectLabel(process)}</div>
          </div>
          <div className="session-row-field">
            <div className="detail-field-label">cwd</div>
            <div className="session-row-mono">{process.cwd}</div>
          </div>
          {process.startedAt !== undefined && (
            <div className="session-row-field">
              <div className="detail-field-label">起動時刻</div>
              <div>{formatAbsoluteTime(process.startedAt)}</div>
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}
