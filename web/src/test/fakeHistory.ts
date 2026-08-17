import { vi } from 'vitest';

export interface FakeHistory {
  pushState: ReturnType<typeof vi.fn>;
  back: ReturnType<typeof vi.fn>;
  getCurrentState: () => unknown;
}

export function installFakeHistory(initialState: unknown = {}): FakeHistory {
  const entries: unknown[] = [initialState];
  let index = 0;

  const pushState = vi.fn((state: unknown) => {
    entries.splice(index + 1);
    entries.push(state);
    index = entries.length - 1;
  });

  const back = vi.fn(() => {
    if (index <= 0) {
      return;
    }
    index -= 1;
    window.dispatchEvent(
      new PopStateEvent('popstate', { state: entries[index] }),
    );
  });

  vi.spyOn(window.history, 'pushState').mockImplementation((state) => {
    pushState(state);
  });
  vi.spyOn(window.history, 'back').mockImplementation(() => {
    back();
  });

  Object.defineProperty(window.history, 'state', {
    configurable: true,
    get: () => entries[index],
  });

  return {
    pushState,
    back,
    getCurrentState: () => entries[index],
  };
}
