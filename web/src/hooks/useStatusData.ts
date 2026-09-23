import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { fetchStatus } from '../api';
import { setBoardTimeZoneOverride } from '../boardTimeZone';

/**
 * bdboard-62p4 PR-3: App.tsx の `status` クエリ、それに連動してサーバー側の
 * タイムゾーンを反映する useEffect、および lastRefreshAt/statusErrors の
 * 導出を集約した。queryKey/queryFn と effect の依存配列・本体は元の App.tsx
 * (旧 L256-263, L758-759) から1文字も変えていない。
 */
export function useStatusData() {
  const statusQuery = useQuery({
    queryKey: ['status'],
    queryFn: fetchStatus,
  });

  useEffect(() => {
    setBoardTimeZoneOverride(statusQuery.data?.boardTimeZone);
  }, [statusQuery.data?.boardTimeZone]);

  const lastRefreshAt = statusQuery.data?.lastRefreshAt;
  const statusErrors = statusQuery.data?.errors ?? [];

  return { statusQuery, lastRefreshAt, statusErrors };
}
