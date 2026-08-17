import { afterEach, describe, expect, it, vi } from 'vitest';
import { updateAppBadge } from './appBadge';

type BadgeNavigator = Navigator & {
  setAppBadge?: (contents?: number) => Promise<void>;
  clearAppBadge?: () => Promise<void>;
};

function installBadgeNavigator(options: {
  setAppBadge?: (contents?: number) => Promise<void>;
  clearAppBadge?: () => Promise<void>;
}): void {
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    // Intentionally a partial mock (only the badge-related members under test),
    // not a full Navigator — cast rather than `satisfies BadgeNavigator`, which
    // would demand every real Navigator property.
    value: {
      ...(options.setAppBadge !== undefined ? { setAppBadge: options.setAppBadge } : {}),
      ...(options.clearAppBadge !== undefined ? { clearAppBadge: options.clearAppBadge } : {}),
    } as BadgeNavigator,
  });
}

describe('updateAppBadge', () => {
  const originalNavigator = globalThis.navigator;

  afterEach(() => {
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: originalNavigator,
    });
    vi.restoreAllMocks();
  });

  it('calls setAppBadge with the count when count is greater than zero', () => {
    const setAppBadge = vi.fn().mockResolvedValue(undefined);
    const clearAppBadge = vi.fn().mockResolvedValue(undefined);
    installBadgeNavigator({ setAppBadge, clearAppBadge });

    updateAppBadge(3);

    expect(setAppBadge).toHaveBeenCalledWith(3);
    expect(clearAppBadge).not.toHaveBeenCalled();
  });

  it('calls clearAppBadge when count is zero', () => {
    const setAppBadge = vi.fn().mockResolvedValue(undefined);
    const clearAppBadge = vi.fn().mockResolvedValue(undefined);
    installBadgeNavigator({ setAppBadge, clearAppBadge });

    updateAppBadge(0);

    expect(clearAppBadge).toHaveBeenCalledTimes(1);
    expect(setAppBadge).not.toHaveBeenCalled();
  });

  it('calls clearAppBadge when count is negative', () => {
    const setAppBadge = vi.fn().mockResolvedValue(undefined);
    const clearAppBadge = vi.fn().mockResolvedValue(undefined);
    installBadgeNavigator({ setAppBadge, clearAppBadge });

    updateAppBadge(-5);

    expect(clearAppBadge).toHaveBeenCalledTimes(1);
    expect(setAppBadge).not.toHaveBeenCalled();
  });

  it('does nothing when setAppBadge is unavailable', () => {
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {},
    });

    expect(() => updateAppBadge(2)).not.toThrow();
  });

  it('does not throw when setAppBadge rejects', async () => {
    const setAppBadge = vi.fn().mockRejectedValue(new Error('badge failed'));
    installBadgeNavigator({ setAppBadge });

    expect(() => updateAppBadge(1)).not.toThrow();

    await Promise.resolve();
    await Promise.resolve();
  });

  it('does not throw when clearAppBadge rejects', async () => {
    const setAppBadge = vi.fn().mockResolvedValue(undefined);
    const clearAppBadge = vi.fn().mockRejectedValue(new Error('clear failed'));
    installBadgeNavigator({ setAppBadge, clearAppBadge });

    expect(() => updateAppBadge(0)).not.toThrow();

    await Promise.resolve();
    await Promise.resolve();
  });
});
