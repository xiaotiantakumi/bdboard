import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  fetchHygieneThresholdsConfig,
  putHygieneThresholdsConfig,
  type HygieneThresholdsConfigDto,
} from '../../api';
import { useHygieneThresholdsForm } from './useHygieneThresholdsForm';

vi.mock('../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api')>();
  return {
    ...actual,
    fetchHygieneThresholdsConfig: vi.fn(),
    putHygieneThresholdsConfig: vi.fn(),
  };
});

const fetchHygieneThresholdsConfigMock = vi.mocked(fetchHygieneThresholdsConfig);
const putHygieneThresholdsConfigMock = vi.mocked(putHygieneThresholdsConfig);

const DAY_MS = 24 * 60 * 60 * 1000;

function makeConfig(
  overrides: Partial<HygieneThresholdsConfigDto> = {},
): HygieneThresholdsConfigDto {
  return {
    staleInProgressAfterMs: 7 * DAY_MS,
    highPriorityMax: 1,
    stalePendingDecisionAfterMs: 3 * DAY_MS,
    closedWithoutEvidenceWindowMs: 14 * DAY_MS,
    version: 'hygiene-thresholds-v1',
    defaults: {
      staleInProgressAfterMs: 7 * DAY_MS,
      highPriorityMax: 1,
      stalePendingDecisionAfterMs: 3 * DAY_MS,
      closedWithoutEvidenceWindowMs: 14 * DAY_MS,
    },
    ...overrides,
  };
}

function createWrapper(queryClient: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

describe('useHygieneThresholdsForm', () => {
  beforeEach(() => {
    fetchHygieneThresholdsConfigMock.mockReset();
    putHygieneThresholdsConfigMock.mockReset();
    fetchHygieneThresholdsConfigMock.mockResolvedValue(makeConfig());
    putHygieneThresholdsConfigMock.mockResolvedValue(
      makeConfig({ version: 'hygiene-thresholds-v2' }),
    );
  });

  it('hydrates values/version from the fetched config once loaded', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useHygieneThresholdsForm(), {
      wrapper: createWrapper(queryClient),
    });

    await waitFor(() => expect(result.current.query.data).toBeDefined());
    expect(result.current.values).toEqual({
      staleInProgressDays: '7',
      highPriorityMax: '1',
      stalePendingDecisionDays: '3',
      closedWithoutEvidenceDays: '14',
    });
    expect(result.current.isDirty).toBe(false);
  });

  it('marks dirty on change and stops hydrating from refetches while dirty', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useHygieneThresholdsForm(), {
      wrapper: createWrapper(queryClient),
    });
    await waitFor(() => expect(result.current.query.data).toBeDefined());

    act(() => {
      result.current.onStaleInProgressDaysChange('30');
    });
    expect(result.current.values.staleInProgressDays).toBe('30');
    expect(result.current.isDirty).toBe(true);

    // Simulate another session saving in the background: a refetch lands new data, but the
    // local edit must not be clobbered while dirty (mirrors the board-thresholds bdboard-chp
    // guard this hook was extracted alongside).
    fetchHygieneThresholdsConfigMock.mockResolvedValue(
      makeConfig({ version: 'hygiene-thresholds-v2' }),
    );
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ['hygiene-thresholds-config'] });
    });
    expect(result.current.values.staleInProgressDays).toBe('30');
  });

  it('submits the loaded version and clears dirty + shows feedback on success', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useHygieneThresholdsForm(), {
      wrapper: createWrapper(queryClient),
    });
    await waitFor(() => expect(result.current.query.data).toBeDefined());

    act(() => {
      result.current.onStaleInProgressDaysChange('30');
    });
    await act(async () => {
      result.current.onSubmit();
    });

    await waitFor(() => {
      expect(putHygieneThresholdsConfigMock).toHaveBeenCalledWith({
        staleInProgressAfterMs: 30 * DAY_MS,
        highPriorityMax: 1,
        stalePendingDecisionAfterMs: 3 * DAY_MS,
        closedWithoutEvidenceWindowMs: 14 * DAY_MS,
        version: 'hygiene-thresholds-v1',
      });
    });
    await waitFor(() => expect(result.current.isDirty).toBe(false));
    await waitFor(() => expect(result.current.feedback.message).toBe('健全性閾値を保存しました'));
  });

  it("updates the local version from the PUT response so it doesn't wait on the GET refetch", async () => {
    // Isolates onSuccess's setHygieneThresholdsVersion(data.version) from the invalidateQueries
    // refetch that follows it: the refetch is left hanging (never resolves) so only the direct
    // setVersion call can be responsible for the mutationFn picking up 'hygiene-thresholds-v2' on
    // a second, immediate submit. Without this, the version comes from the refetch instead.
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useHygieneThresholdsForm(), {
      wrapper: createWrapper(queryClient),
    });
    await waitFor(() => expect(result.current.query.data).toBeDefined());

    // Only the refetch triggered by the upcoming save's invalidateQueries hangs; the initial
    // mount fetch above already resolved normally. Note: react-query awaits the mutation's
    // onSuccess before marking it settled, so with the refetch hanging the first mutation stays
    // "pending" forever (isSaving never flips back to false, no success feedback fires) — that's
    // expected and is why this test only asserts on putHygieneThresholdsConfigMock's call args,
    // not on isDirty/feedback, for the first submit below.
    fetchHygieneThresholdsConfigMock.mockImplementationOnce(() => new Promise(() => {}));
    act(() => {
      result.current.onStaleInProgressDaysChange('30');
    });
    await act(async () => {
      result.current.onSubmit();
    });
    await waitFor(() => {
      expect(putHygieneThresholdsConfigMock).toHaveBeenCalledWith({
        staleInProgressAfterMs: 30 * DAY_MS,
        highPriorityMax: 1,
        stalePendingDecisionAfterMs: 3 * DAY_MS,
        closedWithoutEvidenceWindowMs: 14 * DAY_MS,
        version: 'hygiene-thresholds-v1',
      });
    });

    act(() => {
      result.current.onStaleInProgressDaysChange('40');
    });
    await act(async () => {
      result.current.onSubmit();
    });
    await waitFor(() => {
      expect(putHygieneThresholdsConfigMock).toHaveBeenLastCalledWith({
        staleInProgressAfterMs: 40 * DAY_MS,
        highPriorityMax: 1,
        stalePendingDecisionAfterMs: 3 * DAY_MS,
        closedWithoutEvidenceWindowMs: 14 * DAY_MS,
        version: 'hygiene-thresholds-v2',
      });
    });
  });

  it('clears dirty and refetches on a 409 conflict', async () => {
    putHygieneThresholdsConfigMock.mockRejectedValue(
      new ApiError(409, 'hygiene thresholds config changed since read', {
        errorMessage: 'hygiene thresholds config changed since read',
      }),
    );
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useHygieneThresholdsForm(), {
      wrapper: createWrapper(queryClient),
    });
    await waitFor(() => expect(result.current.query.data).toBeDefined());

    act(() => {
      result.current.onStaleInProgressDaysChange('30');
    });
    await act(async () => {
      result.current.onSubmit();
    });

    await waitFor(() => expect(result.current.isDirty).toBe(false));
    await waitFor(() => expect(result.current.feedback.isError).toBe(true));
    // "refetches on a 409" must actually refetch: the initial mount fetch plus the
    // invalidateQueries the onError handler issues for the 409 branch.
    await waitFor(() => expect(fetchHygieneThresholdsConfigMock).toHaveBeenCalledTimes(2));
  });
});
