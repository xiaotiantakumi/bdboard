import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computeStatusLevel } from './boardFreshness';
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

  it('commits the first contact immediately on open', () => {
    vi.setSystemTime(new Date('2026-01-01T12:00:00.000Z'));
    const { es, result } = renderBoardStream();

    act(() => es.onopen?.());

    expect(result.current.lastContactAtMs).toBe(new Date('2026-01-01T12:00:00.000Z').getTime());
  });

  it('commits the first contact immediately on ping', () => {
    vi.setSystemTime(new Date('2026-01-01T12:00:00.000Z'));
    const { es, result } = renderBoardStream();

    act(() => es.dispatch('ping'));

    expect(result.current.lastContactAtMs).toBe(new Date('2026-01-01T12:00:00.000Z').getTime());
  });

  it('does not change lastContactAtMs on pings within the commit quantum', () => {
    vi.setSystemTime(new Date('2026-01-01T12:00:00.000Z'));
    const { es, result } = renderBoardStream();
    const firstContactAtMs = new Date('2026-01-01T12:00:00.000Z').getTime();

    act(() => es.dispatch('ping'));
    expect(result.current.lastContactAtMs).toBe(firstContactAtMs);

    vi.setSystemTime(new Date('2026-01-01T12:00:15.000Z'));
    act(() => es.dispatch('ping'));

    expect(result.current.lastContactAtMs).toBe(firstContactAtMs);
  });

  it('commits lastContactAtMs when a ping arrives after the commit quantum', () => {
    vi.setSystemTime(new Date('2026-01-01T12:00:00.000Z'));
    const { es, result } = renderBoardStream();

    act(() => es.dispatch('ping'));
    expect(result.current.lastContactAtMs).toBe(new Date('2026-01-01T12:00:00.000Z').getTime());

    vi.setSystemTime(new Date('2026-01-01T12:00:30.000Z'));
    act(() => es.dispatch('ping'));

    expect(result.current.lastContactAtMs).toBe(new Date('2026-01-01T12:00:30.000Z').getTime());
  });

  it('stays ok while pings are throttled (304 keepalive does not trigger delayed banner)', () => {
    const startMs = new Date('2026-01-01T12:00:00.000Z').getTime();
    vi.setSystemTime(startMs);
    const { es, result } = renderBoardStream();

    act(() => es.onopen?.());

    // 15秒間隔で5分分の ping（304 継続時の keepalive を模擬）
    for (let i = 1; i <= 20; i += 1) {
      vi.setSystemTime(startMs + i * 15_000);
      act(() => es.dispatch('ping'));
    }

    const nowMs = Date.now();
    expect(
      computeStatusLevel('open', result.current.lastContactAtMs, nowMs),
    ).toBe('ok');
  });

  it('updates lastContactAtMs on hello events', () => {
    vi.setSystemTime(new Date('2026-01-01T12:00:00.000Z'));
    const { es, result } = renderBoardStream();

    act(() => es.dispatch('hello'));

    expect(result.current.lastContactAtMs).toBe(new Date('2026-01-01T12:00:00.000Z').getTime());
  });

  describe('reconnect grace period', () => {
    const GRACE_MS = 12_000;

    it('enters reconnecting on onError instead of error immediately', () => {
      const { es, result } = renderBoardStream();

      act(() => es.onopen?.());
      act(() => es.onerror?.());

      expect(result.current.state).toBe('reconnecting');
    });

    it('returns to open within the grace window without ever entering error', () => {
      const { es, result } = renderBoardStream();

      act(() => es.onopen?.());
      act(() => es.onerror?.());

      act(() => vi.advanceTimersByTime(GRACE_MS - 1));
      // Pins the lower bound of the grace period: a shorter RECONNECT_GRACE_MS
      // would already have flipped this to the hard 'error' wording.
      expect(result.current.state).toBe('reconnecting');

      act(() => es.onopen?.());
      expect(result.current.state).toBe('open');

      // The timer armed by that onError is still pending here. If onOpen did
      // not clear it, it would fire now and knock a healthy connection back to
      // 'error' — the exact flicker this ticket is about.
      act(() => vi.advanceTimersByTime(GRACE_MS));
      expect(result.current.state).toBe('open');
    });

    it('replaces the shared EventSource when reconnect is invoked', () => {
      const { es, result } = renderBoardStream();

      act(() => es.onopen?.());
      expect(MockEventSource.instances).toHaveLength(1);

      act(() => result.current.reconnect());

      // Without this, the button would only repaint the banner while the dead
      // EventSource (readyState CLOSED, never auto-retrying) stayed in place.
      expect(es.close).toHaveBeenCalledOnce();
      expect(MockEventSource.instances).toHaveLength(2);

      const newEs = MockEventSource.instances.at(-1)!;
      expect(newEs).not.toBe(es);
      act(() => newEs.onopen?.());
      expect(result.current.state).toBe('open');
    });

    it('revalidates everything after a manual reconnect reopens', () => {
      const { es, result, invalidateSpy } = renderBoardStream();

      act(() => es.onopen?.());
      invalidateSpy.mockClear();

      act(() => result.current.reconnect());
      act(() => MockEventSource.instances.at(-1)!.onopen?.());

      // The close→open window swallows any event fired while it was down, so
      // the first open after a manual reconnect has to refetch like an
      // error-driven reconnect does.
      const keys = invalidatedKeys(invalidateSpy);
      for (const key of ALL_INVALIDATED_KEYS) {
        expect(keys).toContain(key);
      }
    });

    it('escalates to error after the grace window expires', () => {
      const { es, result } = renderBoardStream();

      act(() => es.onopen?.());
      act(() => es.onerror?.());

      act(() => vi.advanceTimersByTime(GRACE_MS));

      expect(result.current.state).toBe('error');
    });

    it('does not restart the grace timer on consecutive onError events', () => {
      const { es, result } = renderBoardStream();

      act(() => es.onopen?.());
      act(() => es.onerror?.());

      act(() => vi.advanceTimersByTime(5000));
      act(() => es.onerror?.());

      act(() => vi.advanceTimersByTime(7000));

      expect(result.current.state).toBe('error');
    });

    it('clears the grace timer when reconnect is invoked', () => {
      const { es, result } = renderBoardStream();

      act(() => es.onopen?.());
      act(() => es.onerror?.());

      act(() => result.current.reconnect());

      expect(result.current.state).toBe('connecting');

      act(() => vi.advanceTimersByTime(GRACE_MS));

      expect(result.current.state).toBe('connecting');
    });

    it('stays in error after escalation when EventSource keeps firing onError', () => {
      const { es, result } = renderBoardStream();

      act(() => es.onopen?.());
      act(() => es.onerror?.());

      act(() => vi.advanceTimersByTime(GRACE_MS));
      expect(result.current.state).toBe('error');

      act(() => es.onerror?.());
      expect(result.current.state).toBe('error');

      act(() => vi.advanceTimersByTime(GRACE_MS));
      expect(result.current.state).toBe('error');
    });

    it('resets escalation on onopen so a later drop can use grace again', () => {
      const { es, result } = renderBoardStream();

      act(() => es.onopen?.());
      act(() => es.onerror?.());

      act(() => vi.advanceTimersByTime(GRACE_MS));
      expect(result.current.state).toBe('error');

      act(() => es.onopen?.());
      expect(result.current.state).toBe('open');

      act(() => es.onerror?.());
      expect(result.current.state).toBe('reconnecting');

      act(() => vi.advanceTimersByTime(GRACE_MS));
      expect(result.current.state).toBe('error');
    });
  });
});
