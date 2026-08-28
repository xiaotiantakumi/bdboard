import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { BoardStreamResult } from '../useBoardStream';
import { useLastServerContact } from './useLastServerContact';

// useBoardStream を丸ごと差し替えているので react-query のコンテキストは使われない。
// QueryClientProvider の wrapper は要らない (fable レビュー指摘, bdboard-9qa)。
const useBoardStreamMock = vi.fn<() => BoardStreamResult>(() => ({
  state: 'open',
  lastContactAtMs: 1_000,
  reconnect: vi.fn(),
  connectStalled: false,
}));

vi.mock('../useBoardStream', () => ({
  useBoardStream: () => useBoardStreamMock(),
}));

describe('useLastServerContact', () => {
  it('merges SSE contact with boardQuery.dataUpdatedAt using the latest timestamp', () => {
    const { result } = renderHook(() => useLastServerContact(5_000));

    expect(result.current.streamState).toBe('open');
    expect(result.current.lastContactAtMs).toBe(5_000);
  });

  it('treats react-query dataUpdatedAt 0 as no contact when SSE has not contacted yet', () => {
    useBoardStreamMock.mockReturnValueOnce({
      state: 'connecting',
      lastContactAtMs: null,
      reconnect: vi.fn(),
      connectStalled: false,
    });

    const { result } = renderHook(() => useLastServerContact(0));

    expect(result.current.lastContactAtMs).toBeUndefined();
  });
});
