import { describe, expect, it, vi } from 'vitest';
import { createEventHub } from './event-hub.js';

describe('createEventHub', () => {
  it('delivers published events to all subscribers', () => {
    const hub = createEventHub();
    const receivedA: string[] = [];
    const receivedB: string[] = [];

    hub.subscribe((event) => {
      receivedA.push(event.name);
    });
    hub.subscribe((event) => {
      receivedB.push(event.name);
    });

    hub.publish({ name: 'board.changed', data: { ok: true } });

    expect(receivedA).toEqual(['board.changed']);
    expect(receivedB).toEqual(['board.changed']);
  });

  it('stops delivery after unsubscribe', () => {
    const hub = createEventHub();
    const received: string[] = [];

    const unsubscribe = hub.subscribe((event) => {
      received.push(event.name);
    });

    hub.publish({ name: 'board.changed', data: {} });
    unsubscribe();
    hub.publish({ name: 'session.changed', data: {} });
    unsubscribe();

    expect(received).toEqual(['board.changed']);
  });

  it('isolates listener errors from other listeners', () => {
    const hub = createEventHub();
    const received: string[] = [];
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    hub.subscribe(() => {
      throw new Error('boom');
    });
    hub.subscribe((event) => {
      received.push(event.name);
    });

    hub.publish({ name: 'project.scanned', data: {} });

    expect(received).toEqual(['project.scanned']);
    expect(errorSpy).toHaveBeenCalled();

    errorSpy.mockRestore();
  });

  it('tracks subscriber count', () => {
    const hub = createEventHub();

    expect(hub.subscriberCount()).toBe(0);

    const unsubscribeA = hub.subscribe(() => {});
    const unsubscribeB = hub.subscribe(() => {});

    expect(hub.subscriberCount()).toBe(2);

    unsubscribeA();
    expect(hub.subscriberCount()).toBe(1);

    unsubscribeB();
    unsubscribeB();
    expect(hub.subscriberCount()).toBe(0);
  });
});
