import { useQuery } from '@tanstack/react-query';
import { fetchIssueReportPendingCount } from '../api/issue-reports';

/**
 * 不具合報告の react-query のキーは root を 'issue-reports' に揃える (bdboard-4y8q.3.2): 一覧 ['issue-reports', 'list']、
 * 中身 ['issue-reports', 'detail', id]、件数 ['issue-reports', 'pending-count']。編集・見送りのあとは
 * ['issue-reports'] ごと無効にして、まとめて読み直す。root は boardChangedQueryKeys.test.ts が静的に読むので
 * 各ファイルでリテラルで書く。
 */
const ISSUE_REPORTS_PENDING_COUNT_QUERY_KEY = ['issue-reports', 'pending-count'] as const;

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
