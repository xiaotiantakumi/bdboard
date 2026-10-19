import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api/http', () => ({
  fetchJson: vi.fn(),
}));

const openListeners = new Set<() => void>();
vi.mock('../lib/sseConnection', () => ({
  acquireSharedEventSource: () => ({
    addOpenListener: (l: () => void) => openListeners.add(l),
    removeOpenListener: (l: () => void) => openListeners.delete(l),
    release: () => undefined,
  }),
}));

import { fetchJson } from '../api/http';
import {
  VISIBLE_PROJECTS_HEARTBEAT_MS,
  VISIBLE_PROJECTS_RETRY_MS,
  buildVisibleProjectsPayload,
  useReportVisibleProjects,
} from './useReportVisibleProjects';

const fetchJsonMock = vi.mocked(fetchJson);

function bodies(): unknown[] {
  return fetchJsonMock.mock.calls.map(([, init]) => JSON.parse(typeof init?.body === 'string' ? init.body : '{}'));
}

function setup(initial: string[]) {
  const queryClient = new QueryClient();
  const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  const view = renderHook(({ ids }) => useReportVisibleProjects(ids), {
    wrapper,
    initialProps: { ids: initial },
  });
  return { ...view, invalidate };
}

describe('useReportVisibleProjects', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fetchJsonMock.mockReset();
    fetchJsonMock.mockResolvedValue({ ok: true });
    openListeners.clear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('builds a wildcard payload for an empty selection and an id list otherwise', () => {
    expect(buildVisibleProjectsPayload('c', [])).toEqual({ clientId: 'c', all: true });
    expect(buildVisibleProjectsPayload('c', ['/a'])).toEqual({ clientId: 'c', projectIds: ['/a'] });
  });

  it('reports on load with the wildcard and invalidates status after success', async () => {
    const { invalidate } = setup([]);
    await act(async () => {
      await Promise.resolve();
    });
    expect(bodies()[0]).toMatchObject({ all: true });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['status'] });
  });

  it('re-reports when the selection changes', async () => {
    const { rerender } = setup(['/a']);
    await act(async () => {});
    rerender({ ids: ['/a', '/b'] });
    await act(async () => {});
    expect(bodies().at(-1)).toMatchObject({ projectIds: ['/a', '/b'] });
  });

  it('sends a heartbeat inside the server TTL', async () => {
    setup(['/a']);
    await act(async () => {});
    const before = fetchJsonMock.mock.calls.length;
    await act(async () => {
      vi.advanceTimersByTime(VISIBLE_PROJECTS_HEARTBEAT_MS);
    });
    expect(fetchJsonMock.mock.calls.length).toBe(before + 1);
    expect(VISIBLE_PROJECTS_HEARTBEAT_MS).toBeLessThan(5 * 60_000);
  });

  it('retries a failed report after a few seconds', async () => {
    fetchJsonMock.mockRejectedValueOnce(new Error('down'));
    setup(['/a']);
    await act(async () => {});
    expect(fetchJsonMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      vi.advanceTimersByTime(VISIBLE_PROJECTS_RETRY_MS);
    });
    expect(fetchJsonMock).toHaveBeenCalledTimes(2);
  });

  it('re-reports when the SSE connection opens', async () => {
    setup(['/a']);
    await act(async () => {});
    const before = fetchJsonMock.mock.calls.length;
    await act(async () => {
      for (const l of openListeners) l();
    });
    expect(fetchJsonMock.mock.calls.length).toBe(before + 1);
  });
});
