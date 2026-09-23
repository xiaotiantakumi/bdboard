import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { fetchBoardThresholdsConfig } from '../api';
import type { WipLimitsOverrides } from '../wip-limits';

/**
 * bdboard-62p4 PR-3: App.tsx の `board-thresholds-config` クエリと、そこから
 * 導く wipLimitsOverrides を集約した。queryKey/queryFn/retry と useMemo の
 * 依存配列・本体は元の App.tsx (旧 L305-309, L332-343) から1文字も
 * 変えていない。
 */
export function useBoardThresholdsData() {
  const boardThresholdsQuery = useQuery({
    queryKey: ['board-thresholds-config'],
    queryFn: fetchBoardThresholdsConfig,
    retry: false,
  });

  const wipLimitsOverrides = useMemo((): WipLimitsOverrides => {
    const config = boardThresholdsQuery.data;
    if (config === undefined) {
      return {};
    }
    return {
      ...(config.inProgressWipLimit !== null
        ? { inProgressWipLimit: config.inProgressWipLimit }
        : {}),
      inProgressWipLimitByProject: config.inProgressWipLimitByProject,
    };
  }, [boardThresholdsQuery.data]);

  return { boardThresholdsQuery, wipLimitsOverrides };
}
