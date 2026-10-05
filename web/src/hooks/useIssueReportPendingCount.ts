import { useQuery } from '@tanstack/react-query';
import { fetchIssueReportPendingCount } from '../api/issue-reports';

/**
 * 不具合報告の react-query のキー (bdboard-4y8q.3.2)。編集・見送りのあとは ISSUE_REPORTS_QUERY_KEY ごと
 * 無効にして、一覧・中身・件数をまとめて読み直す。
 */
export const ISSUE_REPORTS_QUERY_KEY = ['issue-reports'] as const;
export const ISSUE_REPORTS_LIST_QUERY_KEY = ['issue-reports', 'list'] as const;
export const ISSUE_REPORTS_PENDING_COUNT_QUERY_KEY = ['issue-reports', 'pending-count'] as const;

export function issueReportDetailQueryKey(id: string) {
  return ['issue-reports', 'detail', id] as const;
}

/**
 * 下書きは bd の外 (data/issue-drafts) にあり、ボードの SSE では変化が届かない。受け取りは別のプロジェクトの
 * 報告スクリプトから来るので、タブの件数は一定の間隔で読み直す。
 */
const PENDING_COUNT_REFETCH_MS = 60_000;

/** タブのバッジとデイリーダイジェスト用の未処理件数。読めないときは null (呼び出し側で 0 扱いや「不明」にする)。 */
export function useIssueReportPendingCount(): { readonly count: number | null; readonly isLoading: boolean } {
  const query = useQuery({
    queryKey: ISSUE_REPORTS_PENDING_COUNT_QUERY_KEY,
    queryFn: fetchIssueReportPendingCount,
    refetchInterval: PENDING_COUNT_REFETCH_MS,
  });
  const value = query.data?.pendingCount;
  return {
    count: typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null,
    isLoading: query.isLoading,
  };
}
