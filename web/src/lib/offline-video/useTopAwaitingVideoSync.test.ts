import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetchAtHome: vi.fn(async () => 'yes' as const),
  runAutoTopSync: vi.fn(async (_ids: readonly string[], options: { home?: Promise<string> }) =>
    (await options.home) ?? 'yes'),
}));

vi.mock('../../api/local-files', () => ({ fetchAtHome: mocks.fetchAtHome }));
vi.mock('./sync-top-awaiting', () => ({
  isUnauthorized: () => false,
  runAutoTopSync: mocks.runAutoTopSync,
  syncTopAwaitingVideos: vi.fn(async () => undefined),
}));

import { useTopAwaitingVideoSync } from './useTopAwaitingVideoSync';

describe('useTopAwaitingVideoSync の自宅判定', () => {
  beforeEach(() => {
    // afterEach の resetAllMocks が実装も消すので、毎回仕込み直す。
    mocks.fetchAtHome.mockImplementation(async () => 'yes' as const);
    mocks.runAutoTopSync.mockImplementation(async (_ids, options) => (await options.home) ?? 'yes');
  });
  afterEach(() => {
    vi.resetAllMocks();
    vi.restoreAllMocks();
  });

  it('マウント時の判定は最初の自動同期だけが使い、前面復帰では聞き直す', async () => {
    renderHook(() => useTopAwaitingVideoSync(['a'], true, true));
    await waitFor(() => expect(mocks.runAutoTopSync).toHaveBeenCalledTimes(1));
    expect(mocks.runAutoTopSync.mock.calls[0]?.[1].home).toBeInstanceOf(Promise);

    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    await waitFor(() => expect(mocks.runAutoTopSync).toHaveBeenCalledTimes(2));
    expect(mocks.runAutoTopSync.mock.calls[1]?.[1].home).toBeUndefined();
  });

  it('設定を後からオンにしたときはマウント時の判定を使わない', async () => {
    const { rerender } = renderHook(
      ({ enabled }) => useTopAwaitingVideoSync(['a'], enabled, true),
      { initialProps: { enabled: false } },
    );
    await waitFor(() => expect(mocks.fetchAtHome).toHaveBeenCalledTimes(1));
    rerender({ enabled: true });
    await waitFor(() => expect(mocks.runAutoTopSync).toHaveBeenCalledTimes(1));
    expect(mocks.runAutoTopSync.mock.calls[0]?.[1].home).toBeUndefined();
  });
});
