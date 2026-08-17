import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetSharedEventSourceForTests,
  acquireSharedEventSource,
} from './sseConnection';

class MockEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;

  static instances: MockEventSource[] = [];

  url: string;
  readyState = MockEventSource.CONNECTING;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private listeners = new Map<string, Set<EventListener>>();

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: EventListener) {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, new Set());
    }
    this.listeners.get(type)!.add(listener);
  }

  removeEventListener(type: string, listener: EventListener) {
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(type: string) {
    this.listeners.get(type)?.forEach((listener) => listener(new Event(type)));
  }

  simulateOpen() {
    this.readyState = MockEventSource.OPEN;
    this.onopen?.();
  }

  simulateError() {
    this.onerror?.();
  }

  close = vi.fn(() => {
    this.readyState = MockEventSource.CLOSED;
  });
}

describe('sseConnection', () => {
  beforeEach(() => {
    MockEventSource.instances = [];
    __resetSharedEventSourceForTests();
    vi.stubGlobal('EventSource', MockEventSource);
  });

  afterEach(() => {
    __resetSharedEventSourceForTests();
    vi.unstubAllGlobals();
  });

  it('creates a single EventSource on first acquire', () => {
    const conn = acquireSharedEventSource();

    expect(MockEventSource.instances).toHaveLength(1);
    expect(MockEventSource.instances[0]!.url).toBe(`${window.location.origin}/api/events`);

    conn.release();
  });

  it('reuses the same EventSource for multiple consumers', () => {
    const first = acquireSharedEventSource();
    const second = acquireSharedEventSource();

    expect(MockEventSource.instances).toHaveLength(1);
    expect(MockEventSource.instances[0]).toBe(MockEventSource.instances.at(-1));

    first.release();
    expect(MockEventSource.instances[0]!.close).not.toHaveBeenCalled();

    second.release();
    expect(MockEventSource.instances[0]!.close).toHaveBeenCalledOnce();
  });

  it('creates a fresh EventSource after the last consumer releases', () => {
    const first = acquireSharedEventSource();
    const firstInstance = MockEventSource.instances[0]!;
    first.release();

    const second = acquireSharedEventSource();

    expect(MockEventSource.instances).toHaveLength(2);
    expect(MockEventSource.instances[1]).not.toBe(firstInstance);

    second.release();
  });

  it('fans out open and error listeners to all consumers', () => {
    const first = acquireSharedEventSource();
    const second = acquireSharedEventSource();
    const es = MockEventSource.instances[0]!;
    const onOpenFirst = vi.fn();
    const onOpenSecond = vi.fn();
    const onErrorFirst = vi.fn();

    first.addOpenListener(onOpenFirst);
    second.addOpenListener(onOpenSecond);
    first.addErrorListener(onErrorFirst);

    es.simulateOpen();
    expect(onOpenFirst).toHaveBeenCalledOnce();
    expect(onOpenSecond).toHaveBeenCalledOnce();

    es.simulateError();
    expect(onErrorFirst).toHaveBeenCalledOnce();

    first.release();
    second.release();
  });

  it('invokes open listeners immediately when joining an already-open connection', () => {
    const first = acquireSharedEventSource();
    const es = MockEventSource.instances[0]!;
    const onOpenFirst = vi.fn();
    first.addOpenListener(onOpenFirst);
    es.simulateOpen();
    onOpenFirst.mockClear();

    const second = acquireSharedEventSource();
    const onOpenSecond = vi.fn();
    second.addOpenListener(onOpenSecond);

    expect(onOpenSecond).toHaveBeenCalledOnce();
    expect(onOpenFirst).not.toHaveBeenCalled();

    first.release();
    second.release();
  });

  it('routes named events through the shared EventSource', () => {
    const conn = acquireSharedEventSource();
    const es = MockEventSource.instances[0]!;
    const onNotification = vi.fn();

    conn.addEventListener('notification', onNotification);
    es.dispatch('notification');
    expect(onNotification).toHaveBeenCalledOnce();

    conn.removeEventListener('notification', onNotification);
    es.dispatch('notification');
    expect(onNotification).toHaveBeenCalledOnce();

    conn.release();
  });
});
