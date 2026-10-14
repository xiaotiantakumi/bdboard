import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeExternalIssue, makeExternalList } from '../test/externalIssueFixtures';
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

/** 両方の問い合わせは失敗のあと 1 回だけ読み直す (retry: 1。既定の待ちは 1 秒) ので、読めないと分かるまで waitFor の既定の 1 秒では足りない。 */
const RETRY_WAIT = { timeout: 4000 };

const TWO_EXTERNAL = makeExternalList({ issues: [makeExternalIssue({ number: 1 }), makeExternalIssue({ number: 2 })] });

beforeEach(() => {
  // 既定は「メンテナ環境でない」(届いた issue が 0 件)。下書きだけの数のテストはそのまま通る。
  vi.mocked(fetchExternalIssues).mockResolvedValue(makeExternalList({ enabled: false, issues: [] }));
});

describe('useIssueReportPendingCount (bdboard-4y8q.3.2)', () => {
  it('returns the count and re-reads it every minute (the drafts are outside bd, so SSE never reports them)', async () => {
    vi.mocked(fetchIssueReportPendingCount).mockResolvedValue({ pendingCount: 3 });
    const { result, client } = setup();
    await waitFor(() => expect(result.current.count).toBe(3));
    expect(ISSUE_REPORTS_REFETCH_MS).toBe(60_000);
    expect(client.getQueryCache().find({ queryKey: ['issue-reports', 'pending-count'] })?.options).toMatchObject({
      refetchInterval: ISSUE_REPORTS_REFETCH_MS,
    });
  });

  it.each([-1, Number.NaN])('treats a nonsensical count (%s) as unknown', async (pendingCount) => {
    vi.mocked(fetchIssueReportPendingCount).mockResolvedValue({ pendingCount });
    const { result } = setup();
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.count).toBeNull();
  });
});

describe('useIssueReportPendingCount with incoming issues (bdboard-4y8q.9.5)', () => {
  it('adds the number of incoming issues to the number of pending drafts', async () => {
    vi.mocked(fetchIssueReportPendingCount).mockResolvedValue({ pendingCount: 3 });
    vi.mocked(fetchExternalIssues).mockResolvedValue(TWO_EXTERNAL);
    const { result } = setup();
    await waitFor(() => expect(result.current.count).toBe(5));
    expect(result.current.isLoading).toBe(false);
  });

  it('re-reads the incoming issues every minute under the shared key', async () => {
    vi.mocked(fetchIssueReportPendingCount).mockResolvedValue({ pendingCount: 0 });
    const { result, client } = setup();
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(client.getQueryCache().find({ queryKey: ['issue-reports', 'external'] })?.options).toMatchObject({
      refetchInterval: ISSUE_REPORTS_REFETCH_MS,
    });
  });

  it('counts the drafts only when incoming issues are not enabled', async () => {
    vi.mocked(fetchIssueReportPendingCount).mockResolvedValue({ pendingCount: 2 });
    vi.mocked(fetchExternalIssues).mockResolvedValue(makeExternalList({ enabled: false, issues: [] }));
    const { result } = setup();
    await waitFor(() => expect(result.current.count).toBe(2));
  });

  it('counts the incoming issues even when the drafts cannot be read', async () => {
    vi.mocked(fetchIssueReportPendingCount).mockRejectedValue(new Error('drafts down'));
    vi.mocked(fetchExternalIssues).mockResolvedValue(TWO_EXTERNAL);
    const { result } = setup();
    await waitFor(() => expect(result.current.count).toBe(2), RETRY_WAIT);
  });

  it('counts the drafts even when the incoming issues cannot be read', async () => {
    vi.mocked(fetchIssueReportPendingCount).mockResolvedValue({ pendingCount: 4 });
    vi.mocked(fetchExternalIssues).mockRejectedValue(new Error('external down'));
    const { result } = setup();
    await waitFor(() => expect(result.current.count).toBe(4), RETRY_WAIT);
  });

  it('is unknown only when neither can be read', async () => {
    vi.mocked(fetchIssueReportPendingCount).mockRejectedValue(new Error('drafts down'));
    vi.mocked(fetchExternalIssues).mockRejectedValue(new Error('external down'));
    const { result } = setup();
    await waitFor(() => expect(result.current.isLoading).toBe(false), RETRY_WAIT);
    expect(result.current.count).toBeNull();
  });
});
