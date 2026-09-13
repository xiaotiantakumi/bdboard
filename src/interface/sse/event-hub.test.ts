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

    hub.publish({ name: 'notification', data: {} });

    expect(received).toEqual(['notification']);
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

  describe('notification replay buffer (bdboard-3tw.161)', () => {
    it('assigns unique epoch-prefixed ids to notifications only', () => {
      const hub = createEventHub({ epoch: 'e1' });
      const received: (string | undefined)[] = [];
      hub.subscribe((event) => {
        received.push(event.id);
      });

      hub.publish({ name: 'notification', data: { n: 1 } });
      hub.publish({ name: 'board.changed', data: {} });
      hub.publish({ name: 'notification', data: { n: 2 } });

      expect(received).toEqual(['e1-1', undefined, 'e1-2']);
    });

    it('keeps notifications published with no subscribers', () => {
      const hub = createEventHub({ epoch: 'e1' });

      hub.publish({ name: 'notification', data: { n: 1 } });
      hub.publish({ name: 'session.changed', data: {} });

      expect(hub.notificationsSince(undefined)).toEqual([
        { name: 'notification', data: { n: 1 }, id: 'e1-1' },
      ]);
    });

    it('caps the buffer and drops the oldest first', () => {
      const hub = createEventHub({ epoch: 'e1', notificationBufferSize: 3 });

      for (let n = 1; n <= 5; n++) {
        hub.publish({ name: 'notification', data: { n } });
      }

      expect(hub.notificationsSince(null).map((event) => event.id)).toEqual([
        'e1-3',
        'e1-4',
        'e1-5',
      ]);
    });

    it('defaults to a 50-entry buffer', () => {
      const hub = createEventHub({ epoch: 'e1' });

      for (let n = 1; n <= 60; n++) {
        hub.publish({ name: 'notification', data: { n } });
      }

      const replay = hub.notificationsSince(undefined);
      expect(replay).toHaveLength(50);
      expect(replay[0]?.id).toBe('e1-11');
      expect(replay.at(-1)?.id).toBe('e1-60');
    });

    it('returns only notifications newer than a same-epoch id', () => {
      const hub = createEventHub({ epoch: 'e1' });
      for (let n = 1; n <= 3; n++) {
        hub.publish({ name: 'notification', data: { n } });
      }

      expect(hub.notificationsSince('e1-2').map((event) => event.id)).toEqual(['e1-3']);
      expect(hub.notificationsSince('e1-3')).toEqual([]);
    });

    it('returns the whole buffer for a foreign-epoch or malformed id', () => {
      const hub = createEventHub({ epoch: 'e1' });
      hub.publish({ name: 'notification', data: { n: 1 } });
      hub.publish({ name: 'notification', data: { n: 2 } });

      for (const lastEventId of ['old-99', 'e1-', 'e1-abc', '', 'garbage']) {
        expect(hub.notificationsSince(lastEventId).map((event) => event.id)).toEqual([
          'e1-1',
          'e1-2',
        ]);
      }
    });

    it('generates a distinct epoch per hub when none is given', () => {
      const first = createEventHub();
      const second = createEventHub();
      first.publish({ name: 'notification', data: {} });
      second.publish({ name: 'notification', data: {} });

      const firstId = first.notificationsSince(undefined)[0]?.id;
      const secondId = second.notificationsSince(undefined)[0]?.id;
      expect(firstId).toMatch(/^[a-z0-9]+-1$/);
      expect(firstId).not.toBe(secondId);
      expect(second.notificationsSince(firstId)).toHaveLength(1);
    });
  });
});
