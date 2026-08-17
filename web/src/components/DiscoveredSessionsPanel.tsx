import { useEffect, useState } from 'react';
import {
  adoptDiscoveredChatSession,
  ApiError,
  fetchDiscoveredChatSessions,
  type DiscoveredChatSessionDto,
  type SessionTailMessageDto,
} from '../api';

interface DiscoveredSessionsPanelProps {
  projectId: string;
  onResume: (
    sessionId: string,
    agentId: string,
    seedMessages: SessionTailMessageDto[],
  ) => void;
  onClose: () => void;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    return error.errorMessage ?? error.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return 'CLIセッションの取得に失敗しました';
}

function formatActivityTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export function DiscoveredSessionsPanel({
  projectId,
  onResume,
  onClose,
}: DiscoveredSessionsPanelProps) {
  const [sessions, setSessions] = useState<DiscoveredChatSessionDto[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [adoptingSessionId, setAdoptingSessionId] = useState<string | null>(null);
  const [adoptError, setAdoptError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setFetchError(null);
    setAdoptError(null);
    void fetchDiscoveredChatSessions(projectId)
      .then((payload) => {
        if (!cancelled) setSessions(payload.sessions);
      })
      .catch((error: unknown) => {
        if (!cancelled) setFetchError(getErrorMessage(error));
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  async function handleResume(sessionId: string): Promise<void> {
    setAdoptingSessionId(sessionId);
    setAdoptError(null);
    try {
      const result = await adoptDiscoveredChatSession(projectId, sessionId);
      onResume(result.sessionId, result.agentId, result.seedMessages ?? []);
      onClose();
    } catch (error: unknown) {
      setAdoptError(getErrorMessage(error));
    } finally {
      setAdoptingSessionId(null);
    }
  }

  return (
    <section className="chat-discovered-sessions" aria-label="CLIセッションの再開">
      <div className="chat-discovered-sessions-header">
        <h3 className="chat-discovered-sessions-title">CLIセッションを再開</h3>
        <button type="button" className="btn" onClick={onClose}>閉じる</button>
      </div>
      {/* bdboard-81b: cursor-agent 等は discovery 対象外。理由は bdboard-81b の bd comment を参照。 */}
      <p className="chat-discovered-sessions-scope-note">
        対象は claude CLI セッションのみです(cursor-agent 等の他エージェントのチャットはここには出ません)。
      </p>
      {isLoading && <p className="chat-pending">CLIセッションを検索中…</p>}
      {!isLoading && fetchError !== null && (
        <p className="chat-discovered-sessions-error" role="alert">{fetchError}</p>
      )}
      {!isLoading && fetchError === null && sessions.length === 0 && (
        <p className="chat-discovered-sessions-empty">再開できるCLIセッションはありません。</p>
      )}
      {!isLoading && fetchError === null && sessions.length > 0 && (
        <ul className="chat-discovered-sessions-list" aria-label="発見したCLIセッション">
          {sessions.map((session) => {
            const preview = session.lastMessagePreview ?? session.firstMessagePreview;
            return (
              <li key={session.sessionId} className="chat-discovered-sessions-item">
                <div className="chat-discovered-sessions-details">
                  <span className="chat-discovered-sessions-id" title={session.sessionId}>
                    {session.sessionId.slice(0, 8)}
                  </span>
                  {session.alreadyAdopted && (
                    <span className="chat-discovered-sessions-badge">登録済み</span>
                  )}
                  <time dateTime={session.lastActivityAt}>
                    {formatActivityTime(session.lastActivityAt)}
                  </time>
                  {preview !== undefined && preview !== '' && (
                    <span className="chat-discovered-sessions-preview">{preview}</span>
                  )}
                </div>
                <button
                  type="button"
                  className="btn"
                  aria-label={`セッション ${session.sessionId} を再開`}
                  disabled={adoptingSessionId !== null}
                  onClick={() => void handleResume(session.sessionId)}
                >
                  {adoptingSessionId === session.sessionId ? '再開中…' : '再開'}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {adoptError !== null && (
        <p className="chat-discovered-sessions-error" role="alert">{adoptError}</p>
      )}
    </section>
  );
}
