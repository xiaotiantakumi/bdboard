// bdboard-sso1.38: SessionListPanel.tsx にあった sessions/projects/history/processes
// の useQuery 4 本とその派生 useMemo 4 本を、挙動を変えずにこの関数へまとめて移した
// もの。呼び出し順(useQuery x4 → useMemo x4、コード上の元の並びのまま)・依存配列・
// queryKey・refetchInterval・retry は移動前と同一。呼び出し元 SessionListPanel は
// このフック1つだけを呼ぶため、Reactから見た通算のフック呼び出し順序は変わらない。
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  ApiError,
  fetchAgentProcesses,
  fetchProjects,
  fetchSessionHistory,
  fetchSessions,
  type AgentProcessDto,
  type SessionHistoryEntryDto,
} from '../../api';
import { compareStrings } from '../../compare';
import { LIVENESS_ORDER } from '../../liveness';
import {
  buildSessionProjectMap,
  type SessionListTab,
  type SessionRow,
} from './sessionListHelpers';

const SESSION_HISTORY_LIMIT = 50;

export function useSessionListData(
  tab: SessionListTab,
  projectId: string | undefined,
) {
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
    queryKey: ['sessionHistory', SESSION_HISTORY_LIMIT, projectId],
    queryFn: () => fetchSessionHistory(SESSION_HISTORY_LIMIT, projectId),
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

  const historyRows: readonly SessionHistoryEntryDto[] = historyQuery.data ?? [];

  const processRows = useMemo((): readonly AgentProcessDto[] => {
    const processes = processesQuery.data ?? [];
    if (projectId === undefined) {
      return processes;
    }
    return processes.filter((process) => process.projectId === projectId);
  }, [processesQuery.data, projectId]);

  return {
    sessionsQuery,
    projectsQuery,
    historyQuery,
    processesQuery,
    projectName,
    rows,
    historyRows,
    processRows,
  };
}
