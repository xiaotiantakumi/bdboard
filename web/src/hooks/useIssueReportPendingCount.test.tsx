import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ISSUE_REPORTS_REFETCH_MS, useIssueReportPendingCount } from './useIssueReportPendingCount';

vi.mock('../api/issue-reports', () => ({ fetchIssueReportPendingCount: vi.fn() }));
vi.mock('../api/issue-reports-external', () => ({ fetchExternalIssues: vi.fn() }));

import { fetchIssueReportPendingCount } from '../api/issue-reports';
import { fetchExternalIssues } from '../api/issue-reports-external';

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return { client, ...renderHook(() => useIssueReportPendingCount(), { wrapper }) };
}

describe('useIssueReportPendingCount (bdboard-4y8q.3.2)', () => {
  it('returns the count and re-reads it every minute (the drafts are outside bd, so SSE never reports them)', async () => {
    vi.mocked(fetchIssueReportPendingCount).mockResolvedValue({ pendingCount: 3 });
    vi.mocked(fetchExternalIssues).mockResolvedValue({ enabled: true, state: 'ok', fetchedAt: null, error: null, truncated: false, skippedLines: 0, issues: [] });
    const { result, client } = setup();
    await waitFor(() => expect(result.current.count).toBe(3));
    expect(ISSUE_REPORTS_REFETCH_MS).toBe(60_000);
    expect(client.getQueryCache().find({ queryKey: ['issue-reports', 'pending-count'] })?.options).toMatchObject({
      refetchInterval: ISSUE_REPORTS_REFETCH_MS,
    });
  });

  it.each([-1, Number.NaN])('treats a nonsensical count (%s) as unknown', async (pendingCount) => {
    vi.mocked(fetchExternalIssues).mockResolvedValue({ enabled: true, state: 'ok', fetchedAt: null, error: null, truncated: false, skippedLines: 0, issues: [{} as never] });
    vi.mocked(fetchIssueReportPendingCount).mockResolvedValue({ pendingCount });
    const { result } = setup();
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.count).toBe(1);
  });

  it('adds enabled external issues and counts whichever source could be read', async () => {
    vi.mocked(fetchIssueReportPendingCount).mockResolvedValue({ pendingCount: 3 });
    vi.mocked(fetchExternalIssues).mockResolvedValue({ enabled: true, state: 'ok', fetchedAt: null, error: null, truncated: false, skippedLines: 0, issues: [{} as never, {} as never] });
    const { result, client } = setup(); await waitFor(() => expect(result.current.count).toBe(5));
    expect(client.getQueryCache().find({ queryKey: ['issue-reports', 'external'] })?.options.refetchInterval).toBe(ISSUE_REPORTS_REFETCH_MS);
    expect(fetchIssueReportPendingCount).toHaveBeenCalled();
  });
});
