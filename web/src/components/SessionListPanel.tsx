import { useRef, useState } from 'react';
import { ApiError, type SessionDto } from '../api';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { useHistoryBackClose } from '../hooks/useHistoryBackClose';
import {
  SidePanelResizeHandle,
  useResizableSidePanel,
} from '../hooks/useResizableSidePanel';
import { UI_STORAGE_KEYS } from '../uiPersistedState';
import { PlatformLimitationNotice } from './PlatformLimitationNotice';
import { SessionTailViewer } from './SessionTailViewer';
import { SessionActiveList } from './session-list/SessionActiveList';
import { SessionEndedList } from './session-list/SessionEndedList';
import { SessionProcessList } from './session-list/SessionProcessList';
import { SessionListTabBar } from './session-list/SessionListTabBar';
import type { SessionListTab } from './session-list/sessionListHelpers';
import { useSessionListData } from './session-list/useSessionListData';

interface SessionListPanelProps {
  projectId?: string;
  onClose: () => void;
}

export function SessionListPanel({ projectId, onClose }: SessionListPanelProps) {
  const sessionListPanel = useResizableSidePanel(
    UI_STORAGE_KEYS.sessionListPanelWidth,
  );
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

  const {
    sessionsQuery,
    projectsQuery,
    historyQuery,
    processesQuery,
    projectName,
    rows,
    historyRows,
    processRows,
  } = useSessionListData(tab, projectId);

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
        className={`detail-panel resizable-side-panel${sessionListPanel.isResizing ? ' is-resizing' : ''}`}
        style={{ width: `${sessionListPanel.width}px` }}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="session-list-title"
      >
        <SidePanelResizeHandle
          label="セッション一覧パネルの幅を変更"
          panel={sessionListPanel}
        />
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

        <SessionListTabBar tab={tab} onChangeTab={setTab} />

        {/* 空リストや 501 だけでは「壊れている」のか「そもそも動かない」のか
            区別が付かないので、理由をここに出す (bdboard-70z.9)。 */}
        <PlatformLimitationNotice feature="session-discovery" />

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
            <SessionActiveList rows={rows} onOpenTail={setTailSession} />
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
          historyRows.length > 0 && <SessionEndedList rows={historyRows} />}

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
          processRows.length > 0 && <SessionProcessList rows={processRows} />}
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
