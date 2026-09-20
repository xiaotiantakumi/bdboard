import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  fetchScanRootsConfig,
  putScanRootsConfig,
  type ScanRootsConfigDto,
} from '../../api';
import { useScanRootsForm } from './useScanRootsForm';

vi.mock('../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api')>();
  return {
    ...actual,
    fetchScanRootsConfig: vi.fn(),
    putScanRootsConfig: vi.fn(),
  };
});

const fetchScanRootsConfigMock = vi.mocked(fetchScanRootsConfig);
const putScanRootsConfigMock = vi.mocked(putScanRootsConfig);

function makeConfig(overrides: Partial<ScanRootsConfigDto> = {}): ScanRootsConfigDto {
  return {
    scanRoots: [],
    excludePaths: [],
    version: 'scan-roots-v1',
    envOverride: false,
    defaultScanRoots: ['/Users/example/Documents'],
    envScanRoots: [],
    ...overrides,
  };
}

function createWrapper(queryClient: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

describe('useScanRootsForm', () => {
  beforeEach(() => {
    fetchScanRootsConfigMock.mockReset();
    putScanRootsConfigMock.mockReset();
    fetchScanRootsConfigMock.mockResolvedValue(makeConfig());
    putScanRootsConfigMock.mockResolvedValue({
      scanRoots: ['/Users/example/projects'],
      excludePaths: [],
      version: 'scan-roots-v2',
    });
  });

  it('hydrates scanRoots/excludePaths/version from the fetched config once loaded', async () => {
    fetchScanRootsConfigMock.mockResolvedValue(
      makeConfig({ scanRoots: ['/Users/example/projects'], excludePaths: ['/Users/example/tmp'] }),
    );
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useScanRootsForm(), {
      wrapper: createWrapper(queryClient),
    });

    await waitFor(() => expect(result.current.query.data).toBeDefined());
    expect(result.current.scanRoots).toEqual(['/Users/example/projects']);
    expect(result.current.excludePaths).toEqual(['/Users/example/tmp']);
    expect(result.current.isDirty).toBe(false);
  });

  it('adding a valid absolute path marks dirty and clears the hint', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useScanRootsForm(), {
      wrapper: createWrapper(queryClient),
    });
    await waitFor(() => expect(result.current.query.data).toBeDefined());

    act(() => {
      result.current.onNewPathChange('/Users/example/projects');
    });
    act(() => {
      result.current.onAddPath();
    });

    expect(result.current.scanRoots).toEqual(['/Users/example/projects']);
    expect(result.current.isDirty).toBe(true);
    expect(result.current.pathHint).toBe('');
    expect(result.current.newPath).toBe('');
  });

  it('adding a non-absolute path sets a hint and does not mark dirty', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useScanRootsForm(), {
      wrapper: createWrapper(queryClient),
    });
    await waitFor(() => expect(result.current.query.data).toBeDefined());

    act(() => {
      result.current.onNewPathChange('relative/path');
    });
    act(() => {
      result.current.onAddPath();
    });

    expect(result.current.scanRoots).toEqual([]);
    expect(result.current.isDirty).toBe(false);
    expect(result.current.pathHint).not.toBe('');
  });

  it('stops hydrating from refetches while dirty', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useScanRootsForm(), {
      wrapper: createWrapper(queryClient),
    });
    await waitFor(() => expect(result.current.query.data).toBeDefined());

    act(() => {
      result.current.onNewPathChange('/Users/example/projects');
    });
    act(() => {
      result.current.onAddPath();
    });
    expect(result.current.isDirty).toBe(true);

    fetchScanRootsConfigMock.mockResolvedValue(
      makeConfig({ scanRoots: ['/Users/other/root'], version: 'scan-roots-v2' }),
    );
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ['scan-roots-config'] });
    });
    expect(result.current.scanRoots).toEqual(['/Users/example/projects']);
  });

  it('submits the loaded version and clears dirty + shows feedback on success', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useScanRootsForm(), {
      wrapper: createWrapper(queryClient),
    });
    await waitFor(() => expect(result.current.query.data).toBeDefined());

    act(() => {
      result.current.onNewPathChange('/Users/example/projects');
    });
    act(() => {
      result.current.onAddPath();
    });
    await act(async () => {
      result.current.onSubmit();
    });

    await waitFor(() => {
      expect(putScanRootsConfigMock).toHaveBeenCalledWith({
        scanRoots: ['/Users/example/projects'],
        excludePaths: [],
        version: 'scan-roots-v1',
      });
    });
    await waitFor(() => expect(result.current.isDirty).toBe(false));
    await waitFor(() => expect(result.current.feedback.message).toBe('設定を保存しました'));
  });

  it("updates the local version from the PUT response so it doesn't wait on the GET refetch", async () => {
    // Isolates onSuccess's setVersion(data.version) from the invalidateQueries refetch that
    // follows it: the refetch is left hanging (never resolves) so only the direct setVersion
    // call can be responsible for the mutationFn picking up 'scan-roots-v2' on a second,
    // immediate submit. Without this, the version comes from the refetch instead. Note: because
    // react-query awaits onSuccess before marking a mutation settled, the first mutation here
    // stays "pending" forever once its refetch hangs — isSaving/feedback never update for it,
    // which is expected and is why only putScanRootsConfigMock's call args are asserted after
    // the first submit.
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useScanRootsForm(), {
      wrapper: createWrapper(queryClient),
    });
    await waitFor(() => expect(result.current.query.data).toBeDefined());

    // Only the refetch triggered by the upcoming save's invalidateQueries hangs; the initial
    // mount fetch above already resolved normally.
    fetchScanRootsConfigMock.mockImplementationOnce(() => new Promise(() => {}));
    act(() => {
      result.current.onNewPathChange('/Users/example/projects');
    });
    act(() => {
      result.current.onAddPath();
    });
    await act(async () => {
      result.current.onSubmit();
    });
    await waitFor(() => {
      expect(putScanRootsConfigMock).toHaveBeenCalledWith({
        scanRoots: ['/Users/example/projects'],
        excludePaths: [],
        version: 'scan-roots-v1',
      });
    });

    act(() => {
      result.current.onNewPathChange('/Users/example/other');
    });
    act(() => {
      result.current.onAddPath();
    });
    await act(async () => {
      result.current.onSubmit();
    });
    await waitFor(() => {
      expect(putScanRootsConfigMock).toHaveBeenLastCalledWith({
        scanRoots: ['/Users/example/projects', '/Users/example/other'],
        excludePaths: [],
        version: 'scan-roots-v2',
      });
    });
  });

  it('clears dirty and refetches on a 409 conflict', async () => {
    putScanRootsConfigMock.mockRejectedValue(
      new ApiError(409, 'scan roots config changed since read', {
        errorMessage: 'scan roots config changed since read',
      }),
    );
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useScanRootsForm(), {
      wrapper: createWrapper(queryClient),
    });
    await waitFor(() => expect(result.current.query.data).toBeDefined());

    act(() => {
      result.current.onNewPathChange('/Users/example/projects');
    });
    act(() => {
      result.current.onAddPath();
    });
    await act(async () => {
      result.current.onSubmit();
    });

    await waitFor(() => expect(result.current.isDirty).toBe(false));
    await waitFor(() => expect(result.current.feedback.isError).toBe(true));
    // "refetches on a 409" must actually refetch: the initial mount fetch plus the
    // invalidateQueries the onError handler issues for the 409 branch.
    await waitFor(() => expect(fetchScanRootsConfigMock).toHaveBeenCalledTimes(2));
  });
});
