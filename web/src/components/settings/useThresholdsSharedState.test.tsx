import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fetchBoardThresholdsConfig,
  fetchProjects,
  postRefresh,
  putBoardThresholdsConfig,
  type BoardThresholdsConfigDto,
} from '../../api';
import { useThresholdsSharedState } from './useThresholdsSharedState';
import { useBoardThresholdsForm } from './useBoardThresholdsForm';
import { useWipLimitsForm } from './useWipLimitsForm';

vi.mock('../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api')>();
  return {
    ...actual,
    fetchBoardThresholdsConfig: vi.fn(),
    putBoardThresholdsConfig: vi.fn(),
    fetchProjects: vi.fn(),
    postRefresh: vi.fn(),
  };
});

const fetchBoardThresholdsConfigMock = vi.mocked(fetchBoardThresholdsConfig);
const putBoardThresholdsConfigMock = vi.mocked(putBoardThresholdsConfig);
const fetchProjectsMock = vi.mocked(fetchProjects);
const postRefreshMock = vi.mocked(postRefresh);

function makeConfig(overrides: Partial<BoardThresholdsConfigDto> = {}): BoardThresholdsConfigDto {
  // stalledAfterMs/livenessActiveMs/livenessIdleMs/livenessStaleMs are chosen so that
  // msToHours/msToMinutes round-trip to *integer* strings: parseHours/parseMinutes
  // (validators.ts) reject non-integer input, and useBoardThresholdsForm hydrates its
  // fields straight from these via msToHours/msToMinutes.
  return {
    stalledAfterMs: 86_400_000, // 24h
    livenessActiveMs: 60_000, // 1min
    livenessIdleMs: 300_000, // 5min
    livenessStaleMs: 3_600_000, // 1h
    inProgressWipLimit: null,
    inProgressWipLimitByProject: {},
    version: 'thresholds-v1',
    defaults: {
      stalledAfterMs: 86_400_000,
      livenessActiveMs: 60_000,
      livenessIdleMs: 300_000,
      livenessStaleMs: 3_600_000,
      inProgressWipLimit: null,
      inProgressWipLimitByProject: {},
    },
    ...overrides,
  };
}

function createWrapper(queryClient: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

describe('useThresholdsSharedState', () => {
  beforeEach(() => {
    fetchBoardThresholdsConfigMock.mockReset();
    putBoardThresholdsConfigMock.mockReset();
    fetchProjectsMock.mockReset();
    postRefreshMock.mockReset();
    fetchProjectsMock.mockResolvedValue([]);
    postRefreshMock.mockResolvedValue(undefined);
  });

  it('registers the board-thresholds-config query under the exact queryKey shared with App.tsx (bdboard-62p4)', async () => {
    fetchBoardThresholdsConfigMock.mockResolvedValue(makeConfig());
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useThresholdsSharedState(), {
      wrapper: createWrapper(queryClient),
    });

    await waitFor(() => expect(result.current.query.isSuccess).toBe(true));

    expect(
      queryClient.getQueryCache().find({ queryKey: ['board-thresholds-config'] }),
    ).toBeDefined();
  });

  it('hydrates version from the loaded config once neither section is dirty', async () => {
    fetchBoardThresholdsConfigMock.mockResolvedValue(makeConfig({ version: 'thresholds-v1' }));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useThresholdsSharedState(), {
      wrapper: createWrapper(queryClient),
    });

    await waitFor(() => expect(result.current.query.data).toBeDefined());
    expect(result.current.version).toBe('thresholds-v1');
  });

  it('does not overwrite version while thresholdsDirty is true, even if wipDirty is false', async () => {
    fetchBoardThresholdsConfigMock.mockResolvedValue(makeConfig({ version: 'thresholds-v1' }));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useThresholdsSharedState(), {
      wrapper: createWrapper(queryClient),
    });
    await waitFor(() => expect(result.current.version).toBe('thresholds-v1'));

    act(() => {
      result.current.setThresholdsDirty(true);
    });

    // Another session saved in the background; a refetch lands a newer version.
    fetchBoardThresholdsConfigMock.mockResolvedValue(makeConfig({ version: 'thresholds-v2' }));
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ['board-thresholds-config'] });
    });

    expect(result.current.version).toBe('thresholds-v1');
  });

  it('does not overwrite version while wipDirty is true, even if thresholdsDirty is false', async () => {
    fetchBoardThresholdsConfigMock.mockResolvedValue(makeConfig({ version: 'thresholds-v1' }));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useThresholdsSharedState(), {
      wrapper: createWrapper(queryClient),
    });
    await waitFor(() => expect(result.current.version).toBe('thresholds-v1'));

    act(() => {
      result.current.setWipDirty(true);
    });

    fetchBoardThresholdsConfigMock.mockResolvedValue(makeConfig({ version: 'thresholds-v2' }));
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ['board-thresholds-config'] });
    });

    expect(result.current.version).toBe('thresholds-v1');
  });

  it('advances version once both sections become clean again', async () => {
    fetchBoardThresholdsConfigMock.mockResolvedValue(makeConfig({ version: 'thresholds-v1' }));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useThresholdsSharedState(), {
      wrapper: createWrapper(queryClient),
    });
    await waitFor(() => expect(result.current.version).toBe('thresholds-v1'));

    act(() => {
      result.current.setThresholdsDirty(true);
      result.current.setWipDirty(true);
    });
    fetchBoardThresholdsConfigMock.mockResolvedValue(makeConfig({ version: 'thresholds-v2' }));
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ['board-thresholds-config'] });
    });
    expect(result.current.version).toBe('thresholds-v1');

    act(() => {
      result.current.setThresholdsDirty(false);
      result.current.setWipDirty(false);
    });

    await waitFor(() => expect(result.current.version).toBe('thresholds-v2'));
  });
});

// 統合テスト: SettingsPanel が実際に行っている配線 (1回の useThresholdsSharedState() を
// useBoardThresholdsForm / useWipLimitsForm の両方へ渡す) を再現し、(1)
// 両セクションが同一の query を共有すること、(2) 片方を保存すると version が進み、
// もう片方のフォーム(未編集側)も次に保存するとき進んだ version を使うこと =
// 表示が同期することを検証する。
describe('useThresholdsSharedState + useBoardThresholdsForm + useWipLimitsForm wiring', () => {
  beforeEach(() => {
    fetchBoardThresholdsConfigMock.mockReset();
    putBoardThresholdsConfigMock.mockReset();
    fetchProjectsMock.mockReset();
    postRefreshMock.mockReset();
    fetchProjectsMock.mockResolvedValue([]);
    postRefreshMock.mockResolvedValue(undefined);
  });

  function renderWiredForms(queryClient: QueryClient) {
    return renderHook(
      () => {
        const shared = useThresholdsSharedState();
        const boardThresholdsForm = useBoardThresholdsForm({
          query: shared.query,
          version: shared.version,
          onVersionChange: shared.onVersionChange,
          dirty: shared.thresholdsDirty,
          onDirtyChange: shared.setThresholdsDirty,
        });
        const wipLimitsForm = useWipLimitsForm({
          query: shared.query,
          version: shared.version,
          onVersionChange: shared.onVersionChange,
          dirty: shared.wipDirty,
          onDirtyChange: shared.setWipDirty,
        });
        return { shared, boardThresholdsForm, wipLimitsForm };
      },
      { wrapper: createWrapper(queryClient) },
    );
  }

  it('both forms read from the same query instance (single fetch, shared cache entry)', async () => {
    fetchBoardThresholdsConfigMock.mockResolvedValue(makeConfig());
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderWiredForms(queryClient);

    await waitFor(() => expect(result.current.shared.query.data).toBeDefined());

    expect(fetchBoardThresholdsConfigMock).toHaveBeenCalledTimes(1);
    expect(result.current.boardThresholdsForm.values.stalledHours).toBe('24');
    expect(result.current.wipLimitsForm.global.value).toBe('');
  });

  it('syncs the WIP form to the newer version after the thresholds form saves', async () => {
    fetchBoardThresholdsConfigMock.mockResolvedValue(makeConfig({ version: 'thresholds-v1' }));
    putBoardThresholdsConfigMock.mockResolvedValue(makeConfig({ version: 'thresholds-v2' }));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderWiredForms(queryClient);

    await waitFor(() => expect(result.current.shared.query.data).toBeDefined());
    expect(result.current.shared.version).toBe('thresholds-v1');

    act(() => {
      result.current.boardThresholdsForm.onStalledHoursChange('48');
    });
    expect(result.current.shared.thresholdsDirty).toBe(true);

    // The mutation's own onSuccess sets the version directly (onVersionChange(data.version)),
    // independent of the guard effect. Once both dirty flags clear afterwards, the guard effect
    // re-runs too - point the GET mock at the post-save server state so it agrees, mirroring a
    // real backend where a refetch after a save returns the version the save just produced.
    fetchBoardThresholdsConfigMock.mockResolvedValue(makeConfig({ version: 'thresholds-v2' }));

    await act(async () => {
      result.current.boardThresholdsForm.onSubmit();
    });

    await waitFor(() => expect(result.current.shared.version).toBe('thresholds-v2'));
    expect(result.current.shared.thresholdsDirty).toBe(false);

    // The (untouched) WIP form now submits with the version the thresholds save just
    // advanced to, instead of the stale version it loaded with — this is the sync the
    // shared hook exists to guarantee (bdboard-chp).
    await act(async () => {
      result.current.wipLimitsForm.onSubmit();
    });
    await waitFor(() => {
      expect(putBoardThresholdsConfigMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ version: 'thresholds-v2' }),
      );
    });
  });

  it('applies the newer version from a WIP-form save immediately, even while the thresholds form is dirty', async () => {
    // This mirrors the *existing*, unchanged onSuccess wiring: a form's own successful save
    // calls onVersionChange(data.version) unconditionally (it is this tab's own write, not a
    // surprising background refetch), so it is not gated by the other form's dirty flag. Only
    // the guard *effect* (which reacts to background refetches of query.data) is gated by both
    // dirty flags - that guard is exercised separately above and in SettingsPanel.test.tsx's
    // "optimistic lock version while a form is dirty (bdboard-chp)" suite.
    fetchBoardThresholdsConfigMock.mockResolvedValue(makeConfig({ version: 'thresholds-v1' }));
    putBoardThresholdsConfigMock.mockResolvedValue(makeConfig({ version: 'thresholds-v2' }));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderWiredForms(queryClient);

    await waitFor(() => expect(result.current.shared.query.data).toBeDefined());

    act(() => {
      result.current.boardThresholdsForm.onStalledHoursChange('48');
    });
    expect(result.current.shared.thresholdsDirty).toBe(true);

    await act(async () => {
      result.current.wipLimitsForm.onSubmit();
    });

    await waitFor(() => {
      expect(putBoardThresholdsConfigMock).toHaveBeenCalledWith(
        expect.objectContaining({ version: 'thresholds-v1' }),
      );
    });
    // The shared version advances immediately from the WIP save's own onSuccess...
    await waitFor(() => expect(result.current.shared.version).toBe('thresholds-v2'));
    // ...but the thresholds form's own unsaved local edit and dirty flag are untouched, so a
    // background refetch still cannot silently clobber it (covered above).
    expect(result.current.shared.thresholdsDirty).toBe(true);
    expect(result.current.boardThresholdsForm.values.stalledHours).toBe('48');
  });
});
