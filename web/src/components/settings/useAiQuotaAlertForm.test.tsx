import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, fetchAiQuotaAlertConfig, putAiQuotaAlertConfig, type AiQuotaAlertConfigDto } from '../../api';
import { useAiQuotaAlertForm } from './useAiQuotaAlertForm';

vi.mock('../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api')>();
  return {
    ...actual,
    fetchAiQuotaAlertConfig: vi.fn(),
    putAiQuotaAlertConfig: vi.fn(),
  };
});

const fetchAiQuotaAlertConfigMock = vi.mocked(fetchAiQuotaAlertConfig);
const putAiQuotaAlertConfigMock = vi.mocked(putAiQuotaAlertConfig);

function makeConfig(overrides: Partial<AiQuotaAlertConfigDto> = {}): AiQuotaAlertConfigDto {
  return {
    thresholdPercent: 20,
    version: 'ai-quota-alert-v1',
    defaults: { thresholdPercent: 20 },
    ...overrides,
  };
}

function createWrapper(queryClient: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

describe('useAiQuotaAlertForm', () => {
  beforeEach(() => {
    fetchAiQuotaAlertConfigMock.mockReset();
    putAiQuotaAlertConfigMock.mockReset();
    fetchAiQuotaAlertConfigMock.mockResolvedValue(makeConfig());
    putAiQuotaAlertConfigMock.mockResolvedValue(makeConfig({ version: 'ai-quota-alert-v2' }));
  });

  it('hydrates value/version from the fetched config once loaded', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useAiQuotaAlertForm(), {
      wrapper: createWrapper(queryClient),
    });

    await waitFor(() => expect(result.current.query.data).toBeDefined());
    expect(result.current.value).toBe('20');
    expect(result.current.isDirty).toBe(false);
  });

  it('marks dirty on change and stops hydrating from refetches while dirty', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useAiQuotaAlertForm(), {
      wrapper: createWrapper(queryClient),
    });
    await waitFor(() => expect(result.current.query.data).toBeDefined());

    act(() => {
      result.current.onChange('30');
    });
    expect(result.current.value).toBe('30');
    expect(result.current.isDirty).toBe(true);

    // Simulate another session saving in the background: a refetch lands new data, but the
    // local edit must not be clobbered while dirty (mirrors the board-thresholds bdboard-chp
    // guard this hook was extracted alongside).
    fetchAiQuotaAlertConfigMock.mockResolvedValue(makeConfig({ version: 'ai-quota-alert-v2' }));
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ['ai-quota-alert-config'] });
    });
    expect(result.current.value).toBe('30');
  });

  it('submits the loaded version and clears dirty + shows feedback on success', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useAiQuotaAlertForm(), {
      wrapper: createWrapper(queryClient),
    });
    await waitFor(() => expect(result.current.query.data).toBeDefined());

    act(() => {
      result.current.onChange('30');
    });

    await act(async () => {
      result.current.onSubmit();
    });

    await waitFor(() => {
      expect(putAiQuotaAlertConfigMock).toHaveBeenCalledWith({
        thresholdPercent: 30,
        version: 'ai-quota-alert-v1',
      });
    });
    await waitFor(() => expect(result.current.isDirty).toBe(false));
    await waitFor(() =>
      expect(result.current.feedback.message).toBe('AIクォータ通知閾値を保存しました'),
    );
  });

  it('clears dirty and refetches on a 409 conflict', async () => {
    putAiQuotaAlertConfigMock.mockRejectedValue(
      new ApiError(409, 'ai quota alert config changed since read', {
        errorMessage: 'ai quota alert config changed since read',
      }),
    );
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useAiQuotaAlertForm(), {
      wrapper: createWrapper(queryClient),
    });
    await waitFor(() => expect(result.current.query.data).toBeDefined());

    act(() => {
      result.current.onChange('30');
    });
    await act(async () => {
      result.current.onSubmit();
    });

    await waitFor(() => expect(result.current.isDirty).toBe(false));
    await waitFor(() => expect(result.current.feedback.isError).toBe(true));
  });
});
