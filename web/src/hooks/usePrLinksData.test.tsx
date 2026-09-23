import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrBadgeDto } from '../api';

vi.mock('../api', () => ({
  fetchPrLinks: vi.fn(),
}));

import { fetchPrLinks } from '../api';
import { usePrLinksData } from './usePrLinksData';

const fetchPrLinksMock = vi.mocked(fetchPrLinks);

function makeBadge(overrides: Partial<PrBadgeDto> = {}): PrBadgeDto {
  return {
    ticketId: 'bdboard-1',
    projectId: 'proj-1',
    url: 'https://github.com/example/example/pull/1',
    state: 'open',
    checkStatus: 'success',
    ...overrides,
  };
}

function renderPrLinksData(
  selectedProjectIds: string[],
  selectedProjectIdsJoined: string,
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  const view = renderHook(
    () => usePrLinksData(selectedProjectIds, selectedProjectIdsJoined),
    { wrapper },
  );
  return { ...view, queryClient };
}

describe('usePrLinksData', () => {
  beforeEach(() => {
    fetchPrLinksMock.mockReset();
  });

  it('registers the pr-links query under the exact queryKey used by App.tsx', async () => {
    fetchPrLinksMock.mockResolvedValue([]);
    const { result, queryClient } = renderPrLinksData(['p1'], 'p1');

    await waitFor(() => expect(result.current.prLinksQuery.isSuccess).toBe(true));

    expect(queryClient.getQueryCache().find({ queryKey: ['pr-links', 'p1'] })).toBeDefined();
    expect(fetchPrLinksMock).toHaveBeenCalledWith(['p1']);
  });

  it('derives prLinksById keyed by ticketId', async () => {
    const badges = [makeBadge({ ticketId: 'bdboard-1' }), makeBadge({ ticketId: 'bdboard-2', state: 'merged' })];
    fetchPrLinksMock.mockResolvedValue(badges);
    const { result } = renderPrLinksData([], '');

    await waitFor(() => expect(result.current.prLinksQuery.data).toEqual(badges));

    expect(result.current.prLinksById.get('bdboard-1')).toEqual(badges[0]);
    expect(result.current.prLinksById.get('bdboard-2')).toEqual(badges[1]);
  });

  it('invalidates the hygiene query cache once the pr-links fetch has resolved', async () => {
    fetchPrLinksMock.mockResolvedValue([makeBadge()]);
    const { result, queryClient } = renderPrLinksData([], '');
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    await waitFor(() => expect(result.current.prLinksQuery.dataUpdatedAt).toBeGreaterThan(0));
    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['hygiene'] }),
    );
  });

  it('does not invalidate the hygiene query while the pr-links fetch is still pending', () => {
    fetchPrLinksMock.mockReturnValue(new Promise(() => {}));
    // The spy must be attached *before* renderHook mounts the component, since
    // renderHook synchronously runs the first effect pass as part of mounting.
    // Attaching it afterwards would silently miss that first invocation and let
    // the assertion below pass even if the hook's `dataUpdatedAt > 0` guard were
    // removed entirely (bdboard-62p4 PR-3 opus review finding #2).
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    renderPrLinksData([], '', queryClient);

    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it('does not retry pr-links on failure even without a client-level retry override (retry: false is set by the hook itself, matching App.tsx)', async () => {
    fetchPrLinksMock.mockRejectedValue(new Error('boom'));
    // Deliberately omit the `retry: false` defaultOptions override used by the other
    // tests, so a passing test here proves the hook's own `retry: false` is what stops
    // retries -- not an artifact of the test harness's QueryClient configuration.
    const queryClient = new QueryClient();
    const { result } = renderPrLinksData([], '', queryClient);

    await waitFor(() => expect(result.current.prLinksQuery.isError).toBe(true));

    expect(fetchPrLinksMock).toHaveBeenCalledTimes(1);
  });
});
