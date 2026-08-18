import { useQuery } from '@tanstack/react-query';
import { useMemo, useRef, useState } from 'react';
import {
  ApiError,
  fetchAgentProcesses,
  fetchProjects,
  fetchSessionHistory,
  fetchSessions,
  type AgentProcessDto,
  type ProjectDto,
  type SessionDto,
  type SessionHistoryEntryDto,
} from '../api';
import { compareStrings } from '../compare';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { useHistoryBackClose } from '../hooks/useHistoryBackClose';
import {
  LIVENESS_ORDER,
  livenessClass,
  livenessLabel,
  type Liveness,
} from '../liveness';
import { SessionTailViewer } from './SessionTailViewer';

interface SessionListPanelProps {
  projectId?: string;
  onClose: () => void;
}

type SessionListTab = 'active' | 'ended' | 'processes';

const SESSION_HISTORY_LIMIT = 50;

interface SessionRow {
  session: SessionDto;
  projectName: string;
  liveness: Liveness;
}

function formatDateTime(value: string): string {
  return new Date(value).toLocaleString();
}

function buildSessionProjectMap(
  projects: readonly ProjectDto[],
): Map<string, { projectId: string; projectName: string }> {
  const map = new Map<string, { projectId: string; projectName: string }>();
  for (const project of projects) {
    for (const session of project.sessions) {
      map.set(session.sessionId, {
        projectId: project.id,
        projectName: project.name,
      });
    }
  }
  return map;
}

function formatTicketLabel(ticket: SessionHistoryEntryDto['tickets'][number]): string {
  if (ticket.title !== undefined) {
    return `${ticket.ticketId} — ${ticket.title}`;
  }
  return ticket.ticketId;
}

function processProjectLabel(process: AgentProcessDto): string {
  return process.projectName ?? process.cwd;
}

export function SessionListPanel({ projectId, onClose }: SessionListPanelProps) {
  const panelRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const [tab, setTab] = useState<SessionListTab>('active');
  const [tailSession, setTailSession] = useState<SessionDto | null>(null);

  const { requestClose } = useHistoryBackClose({
    panelId: 'sessions',
    onClose,
  });

  useFocusTrap({
    containerRef: panelRef,
    initialFocusRef: closeButtonRef,
    onEscape: requestClose,
  });

  const sessionsQuery = useQuery({
    queryKey: ['sessions'],
    queryFn: fetchSessions,
    refetchInterval: tab === 'active' ? 10_000 : false,
  });

  const projectsQuery = useQuery({
    queryKey: ['projects'],
    queryFn: fetchProjects,
    refetchInterval: tab === 'active' ? 10_000 : false,
  });

  const historyQuery = useQuery({
    queryKey: ['sessionHistory', SESSION_HISTORY_LIMIT],
    queryFn: () => fetchSessionHistory(SESSION_HISTORY_LIMIT),
    enabled: tab === 'ended',
    refetchInterval: tab === 'ended' ? 10_000 : false,
  });

  const processesQuery = useQuery({
    queryKey: ['agentProcesses'],
    queryFn: fetchAgentProcesses,
    enabled: tab === 'processes',
    refetchInterval: tab === 'processes' ? 10_000 : false,
    retry: (failureCount, error) => {
      if (error instanceof ApiError && error.status === 501) {
        return false;
      }
      return failureCount < 1;
    },
  });

  const sessionProjectMap = useMemo(
    () => buildSessionProjectMap(projectsQuery.data ?? []),
    [projectsQuery.data],
  );

  const projectName = useMemo(() => {
    if (projectId === undefined) {
      return undefined;
    }
    return (projectsQuery.data ?? []).find((project) => project.id === projectId)?.name;
  }, [projectId, projectsQuery.data]);

  const rows = useMemo((): SessionRow[] => {
    const sessions = sessionsQuery.data ?? [];

    const mapped = sessions.map((session) => {
      const projectInfo = sessionProjectMap.get(session.sessionId);
      return {
        session,
        projectName: projectInfo?.projectName ?? '—',
        liveness: session.liveness,
      };
    });

    const filtered =
      projectId === undefined
        ? mapped
        : mapped.filter((row) => {
            const info = sessionProjectMap.get(row.session.sessionId);
            return info?.projectId === projectId;
          });

    return filtered.sort((a, b) => {
      const livenessDiff = LIVENESS_ORDER[a.liveness] - LIVENESS_ORDER[b.liveness];
      if (livenessDiff !== 0) {
        return livenessDiff;
      }
      return compareStrings(a.session.sessionId, b.session.sessionId);
    });
  }, [sessionsQuery.data, sessionProjectMap, projectId]);

  const historyRows = useMemo((): readonly SessionHistoryEntryDto[] => {
    const entries = historyQuery.data ?? [];
    if (projectId === undefined) {
      return entries;
    }
    return entries.filter((entry) => entry.projectId === projectId);
  }, [historyQuery.data, projectId]);

  const processRows = useMemo((): readonly AgentProcessDto[] => {
    const processes = processesQuery.data ?? [];
    if (projectId === undefined) {
      return processes;
    }
    return processes.filter((process) => process.projectId === projectId);
  }, [processesQuery.data, projectId]);

  const isActiveTab = tab === 'active';
  const isEndedTab = tab === 'ended';
  const isProcessesTab = tab === 'processes';

  const isLoading = isActiveTab
    ? sessionsQuery.isLoading || projectsQuery.isLoading
    : isEndedTab
      ? historyQuery.isLoading
      : processesQuery.isLoading;

  const error = isActiveTab
    ? sessionsQuery.error ?? projectsQuery.error
    : isEndedTab
      ? historyQuery.error
      : processesQuery.error;

  const processesUnavailable =
    isProcessesTab &&
    processesQuery.error instanceof ApiError &&
    processesQuery.error.status === 501;

  const activeCount = rows.filter((row) => row.liveness === 'active').length;
  const counts = `セッション ${rows.length}（稼働中 ${activeCount}）`;
  const endedCount = historyRows.length;
  const processCount = processRows.length;

  const title =
    projectId === undefined
      ? isActiveTab
        ? `セッション一覧 (${counts})`
        : isEndedTab
          ? `セッション一覧（終了 ${endedCount}）`
          : `セッション一覧（プロセス ${processCount}）`
      : isActiveTab
        ? `${projectName ?? projectId} — セッション (${counts})`
        : isEndedTab
          ? `${projectName ?? projectId} — 終了セッション (${endedCount})`
          : `${projectName ?? projectId} — プロセス (${processCount})`;

  return (
    <>
      <div className="overlay" onClick={requestClose} role="presentation">
      <aside
        ref={panelRef}
        className="detail-panel"
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="session-list-title"
      >
        <div className="detail-header">
          <h2 id="session-list-title" className="detail-title">
            {title}
          </h2>
          <button
            ref={closeButtonRef}
            type="button"
            className="btn detail-close"
            onClick={requestClose}
          >
            閉じる
          </button>
        </div>

        <div className="session-list-tabs">
          <div className="toggle-group">
            <button
              type="button"
              className={`toggle-btn${tab === 'active' ? ' active' : ''}`}
              onClick={() => setTab('active')}
            >
              稼働中
            </button>
            <button
              type="button"
              className={`toggle-btn${tab === 'ended' ? ' active' : ''}`}
              onClick={() => setTab('ended')}
            >
              終了
            </button>
            <button
              type="button"
              className={`toggle-btn${tab === 'processes' ? ' active' : ''}`}
              onClick={() => setTab('processes')}
            >
              プロセス
            </button>
          </div>
        </div>

        {isProcessesTab && (
          <p className="session-processes-note">
            起動中のエージェントプロセスを検知しています。最終活動時刻は分からないため、稼働/停滞の判定はできません。
          </p>
        )}

        {isLoading && <p className="loading">読み込み中…</p>}
        {error !== null && !processesUnavailable && (
          <p className="error-message">
            {error instanceof Error ? error.message : '読み込みに失敗しました'}
          </p>
        )}
        {processesUnavailable && (
          <p className="empty-message">
            この環境ではプロセス検知に対応していません
          </p>
        )}

        {isActiveTab &&
          !isLoading &&
          error === null &&
          rows.length === 0 && (
            <p className="empty-message">表示できるセッションがありません</p>
          )}
        {isActiveTab &&
          !isLoading &&
          error === null &&
          rows.length > 0 && (
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
                    <div>{formatDateTime(row.session.startedAt)}</div>
                  </div>
                  <div className="session-row-field">
                    <div className="detail-field-label">最終活動</div>
                    <div>{formatDateTime(row.session.lastActivityAt)}</div>
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
                      onClick={() => setTailSession(row.session)}
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
          )}

        {isEndedTab &&
          !isLoading &&
          error === null &&
          historyRows.length === 0 && (
            <p className="empty-message">終了したセッションはありません</p>
          )}
        {isEndedTab &&
          !isLoading &&
          error === null &&
          historyRows.length > 0 && (
            <ul className="session-list">
              {historyRows.map((entry) => (
                <li key={entry.session.sessionId} className="session-row">
                  <div className="session-row-field">
                    <div className="detail-field-label">最終活動</div>
                    <div>{formatDateTime(entry.session.lastActivityAt)}</div>
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
          )}

        {isProcessesTab &&
          !isLoading &&
          !processesUnavailable &&
          error === null &&
          processRows.length === 0 && (
            <p className="empty-message">検知されたエージェントプロセスはありません</p>
          )}
        {isProcessesTab &&
          !isLoading &&
          !processesUnavailable &&
          error === null &&
          processRows.length > 0 && (
            <ul className="session-list">
              {processRows.map((process) => (
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
                      <div>{formatDateTime(process.startedAt)}</div>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
      </aside>
    </div>
      {tailSession !== null && (
        <SessionTailViewer
          sessionId={tailSession.sessionId}
          sessionLabel={tailSession.name ?? tailSession.sessionId}
          onClose={() => setTailSession(null)}
        />
      )}
    </>
  );
}
