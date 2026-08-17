import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetSharedEventSourceForTests } from './lib/sseConnection';
import { useBoardStream } from './useBoardStream';

// Minimal controllable EventSource stand-in. jsdom has no real EventSource,
// and the real one can't be driven deterministically from a test anyway —
// this lets us fire onopen/onerror/named events on command.
class MockEventSource {
  static instances: MockEventSource[] = [];

  url: string;
  readyState = 0;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private listeners = new Map<string, Set<() => void>>();

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: () => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }

  removeEventListener(type: string, listener: () => void) {
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(type: string) {
    this.listeners.get(type)?.forEach((listener) => listener());
  }

  close = vi.fn();
}

function renderBoardStream() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  const view = renderHook(() => useBoardStream(), { wrapper });
  const es = MockEventSource.instances.at(-1)!;
  return { ...view, invalidateSpy, es };
}

const ALL_INVALIDATED_KEYS = [
  'board',
  'status',
  'ticket',
  'ticket-comments',
  'pending-decisions',
  'pr-links',
  'sessions',
  'projects',
];

type InvalidateSpy = ReturnType<typeof renderBoardStream>['invalidateSpy'];

function invalidatedKeys(invalidateSpy: InvalidateSpy): string[] {
  return invalidateSpy.mock.calls.map((call) => (call[0] as { queryKey: string[] }).queryKey[0]);
}

describe('useBoardStream', () => {
  beforeEach(() => {
    MockEventSource.instances = [];
    __resetSharedEventSourceForTests();
    vi.stubGlobal('EventSource', MockEventSource);
    vi.useFakeTimers();
  });

  afterEach(() => {
    __resetSharedEventSourceForTests();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('does not revalidate on the first connection (no prior error)', () => {
    const { es, invalidateSpy } = renderBoardStream();

    act(() => es.onopen?.());

    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it('revalidates board, session, and related queries after an onerror followed by onopen', () => {
    const { es, invalidateSpy } = renderBoardStream();

    act(() => es.onopen?.()); // initial connect: no revalidation expected
    invalidateSpy.mockClear();

    act(() => es.onerror?.());
    expect(invalidateSpy).not.toHaveBeenCalled(); // erroring alone doesn't refetch anything

    act(() => es.onopen?.()); // reconnect after the drop

    const keys = invalidatedKeys(invalidateSpy);
    for (const key of ALL_INVALIDATED_KEYS) {
      expect(keys).toContain(key);
    }
  });

  it('does not double-revalidate on a subsequent clean onopen after already recovering', () => {
    const { es, invalidateSpy } = renderBoardStream();

    act(() => es.onopen?.());
    act(() => es.onerror?.());
    act(() => es.onopen?.()); // recovers, revalidates once
    invalidateSpy.mockClear();

    act(() => es.onopen?.()); // e.g. a spurious extra open event with no error in between

    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it('revalidates when the tab becomes visible again, guarded against rapid repeats', () => {
    const { invalidateSpy } = renderBoardStream();

    const visibilityStateSpy = vi
      .spyOn(document, 'visibilityState', 'get')
      .mockReturnValue('visible');

    act(() => document.dispatchEvent(new Event('visibilitychange')));
    const firstCallCount = invalidateSpy.mock.calls.length;
    expect(firstCallCount).toBeGreaterThan(0);
    for (const key of ALL_INVALIDATED_KEYS) {
      expect(invalidatedKeys(invalidateSpy)).toContain(key);
    }

    // Immediately visible again (e.g. a second focus event) — guarded, no extra calls.
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    expect(invalidateSpy.mock.calls.length).toBe(firstCallCount);

    // Past the guard window, visibility changes revalidate again.
    act(() => vi.advanceTimersByTime(5001));
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    expect(invalidateSpy.mock.calls.length).toBeGreaterThan(firstCallCount);

    visibilityStateSpy.mockRestore();
  });

  it('does not revalidate when the tab becomes hidden', () => {
    const { invalidateSpy } = renderBoardStream();

    const visibilityStateSpy = vi
      .spyOn(document, 'visibilityState', 'get')
      .mockReturnValue('hidden');

    act(() => document.dispatchEvent(new Event('visibilitychange')));

    expect(invalidateSpy).not.toHaveBeenCalled();

    visibilityStateSpy.mockRestore();
  });
});
