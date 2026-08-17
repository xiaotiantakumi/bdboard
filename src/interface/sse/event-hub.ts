export type AppEventName = 'board.changed' | 'session.changed' | 'project.scanned';

export interface AppEvent {
  readonly name: AppEventName;
  readonly data: unknown;
}

export interface EventHub {
  publish(event: AppEvent): void;
  subscribe(listener: (event: AppEvent) => void): () => void;
  subscriberCount(): number;
}

export function createEventHub(): EventHub {
  const listeners = new Set<(event: AppEvent) => void>();

  return {
    publish(event: AppEvent): void {
      for (const listener of listeners) {
        try {
          listener(event);
        } catch (err) {
          console.error(err);
        }
      }
    },

    subscribe(listener: (event: AppEvent) => void): () => void {
      listeners.add(listener);
      let active = true;

      return () => {
        if (!active) {
          return;
        }
        active = false;
        listeners.delete(listener);
      };
    },

    subscriberCount(): number {
      return listeners.size;
    },
  };
}
