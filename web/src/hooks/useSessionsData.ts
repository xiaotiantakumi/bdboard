import { useQuery } from '@tanstack/react-query';
import { fetchSessions } from '../api';

/**
 * bdboard-62p4 PR-3: App.tsx の `sessions` クエリと、そこから導く
 * totalSessionCount/activeSessionCount を集約した。queryKey/queryFn と
 * 集計ロジックは元の App.tsx (旧 L251-254, L552-555) から1文字も変えていない。
 */
export function useSessionsData() {
  const sessionsQuery = useQuery({
    queryKey: ['sessions'],
    queryFn: fetchSessions,
  });

  const totalSessionCount = (sessionsQuery.data ?? []).length;
  const activeSessionCount = (sessionsQuery.data ?? []).filter(
    (session) => session.liveness === 'active',
  ).length;

  return { sessionsQuery, totalSessionCount, activeSessionCount };
}
