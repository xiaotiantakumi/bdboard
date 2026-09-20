import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, fetchAgentRunConfig, saveAgentRunConfig, type AgentRunConfigDto } from '../../api';
import { useAgentRunsForm } from './useAgentRunsForm';

vi.mock('../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api')>();
  return {
    ...actual,
    fetchAgentRunConfig: vi.fn(),
    saveAgentRunConfig: vi.fn(),
  };
});

const fetchAgentRunConfigMock = vi.mocked(fetchAgentRunConfig);
const saveAgentRunConfigMock = vi.mocked(saveAgentRunConfig);

function makeConfig(overrides: Partial<AgentRunConfigDto> = {}): AgentRunConfigDto {
  return {
    allowRemoteAgentRuns: false,
    version: 'agent-runs-v1',
    defaults: { allowRemoteAgentRuns: false },
    ...overrides,
  };
}

function createWrapper(queryClient: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

describe('useAgentRunsForm', () => {
  beforeEach(() => {
    fetchAgentRunConfigMock.mockReset();
    saveAgentRunConfigMock.mockReset();
    fetchAgentRunConfigMock.mockResolvedValue(makeConfig());
    saveAgentRunConfigMock.mockResolvedValue(makeConfig({ version: 'agent-runs-v2' }));
  });

  it('hydrates checked/version from the fetched config once loaded', async () => {
    fetchAgentRunConfigMock.mockResolvedValue(makeConfig({ allowRemoteAgentRuns: true }));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useAgentRunsForm(), {
      wrapper: createWrapper(queryClient),
    });

    await waitFor(() => expect(result.current.query.data).toBeDefined());
    expect(result.current.checked).toBe(true);
    expect(result.current.isDirty).toBe(false);
  });

  it('marks dirty on change and does not re-hydrate from a refetch while dirty', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useAgentRunsForm(), {
      wrapper: createWrapper(queryClient),
    });
    await waitFor(() => expect(result.current.query.data).toBeDefined());

    act(() => {
      result.current.onChange(true);
    });
    expect(result.current.checked).toBe(true);
    expect(result.current.isDirty).toBe(true);

    fetchAgentRunConfigMock.mockResolvedValue(
      makeConfig({ allowRemoteAgentRuns: false, version: 'agent-runs-v2' }),
    );
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ['agent-runs-config'] });
    });
    expect(result.current.checked).toBe(true);
  });

  it('submits the loaded version and clears dirty + shows feedback on success', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useAgentRunsForm(), {
      wrapper: createWrapper(queryClient),
    });
    await waitFor(() => expect(result.current.query.data).toBeDefined());

    act(() => {
      result.current.onChange(true);
    });
    await act(async () => {
      result.current.onSubmit();
    });

    await waitFor(() => {
      expect(saveAgentRunConfigMock).toHaveBeenCalledWith({
        allowRemoteAgentRuns: true,
        version: 'agent-runs-v1',
      });
    });
    await waitFor(() => expect(result.current.isDirty).toBe(false));
    await waitFor(() =>
      expect(result.current.feedback.message).toBe('エージェント実行設定を保存しました'),
    );
  });

  it("updates the local version from the PUT response so it doesn't wait on the GET refetch", async () => {
    // Isolates onSuccess's setAgentRunsVersion(data.version) from the invalidateQueries
    // refetch that follows it: the refetch is left hanging (never resolves) so only the direct
    // setVersion call can be responsible for the mutationFn picking up 'agent-runs-v2' on a
    // second, immediate submit. Without this, the version comes from the refetch instead.
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useAgentRunsForm(), {
      wrapper: createWrapper(queryClient),
    });
    await waitFor(() => expect(result.current.query.data).toBeDefined());

    // Only the refetch triggered by the upcoming save's invalidateQueries hangs; the initial
    // mount fetch above already resolved normally.
    fetchAgentRunConfigMock.mockImplementationOnce(() => new Promise(() => {}));
    act(() => {
      result.current.onChange(true);
    });
    await act(async () => {
      result.current.onSubmit();
    });
    await waitFor(() => {
      expect(saveAgentRunConfigMock).toHaveBeenCalledWith({
        allowRemoteAgentRuns: true,
        version: 'agent-runs-v1',
      });
    });

    act(() => {
      result.current.onChange(false);
    });
    await act(async () => {
      result.current.onSubmit();
    });
    await waitFor(() => {
      expect(saveAgentRunConfigMock).toHaveBeenLastCalledWith({
        allowRemoteAgentRuns: false,
        version: 'agent-runs-v2',
      });
    });
  });

  it('clears dirty and refetches on a 409 conflict', async () => {
    saveAgentRunConfigMock.mockRejectedValue(
      new ApiError(409, 'agent run config changed since read', {
        errorMessage: 'agent run config changed since read',
      }),
    );
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useAgentRunsForm(), {
      wrapper: createWrapper(queryClient),
    });
    await waitFor(() => expect(result.current.query.data).toBeDefined());

    act(() => {
      result.current.onChange(true);
    });
    await act(async () => {
      result.current.onSubmit();
    });

    await waitFor(() => expect(result.current.isDirty).toBe(false));
    await waitFor(() => expect(result.current.feedback.isError).toBe(true));
    // "refetches on a 409" must actually refetch: the initial mount fetch plus the
    // invalidateQueries the onError handler issues for the 409 branch.
    await waitFor(() => expect(fetchAgentRunConfigMock).toHaveBeenCalledTimes(2));
  });
});
