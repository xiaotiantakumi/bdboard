// Badging API (navigator.setAppBadge/clearAppBadge) isn't part of the default
// TS `dom` lib, so it's declared here as an ad-hoc feature-detected shape
// rather than relying on `in`-narrowing against the ambient Navigator type.
interface BadgeNavigator {
  setAppBadge?: (contents?: number) => Promise<void>;
  clearAppBadge?: () => Promise<void>;
}

export function updateAppBadge(count: number): void {
  if (typeof navigator === 'undefined') {
    return;
  }

  const nav = navigator as Navigator & BadgeNavigator;
  if (typeof nav.setAppBadge !== 'function') {
    return;
  }

  const normalized = Math.max(0, count);

  if (normalized > 0) {
    void nav.setAppBadge(normalized).catch(() => {});
    return;
  }

  if (typeof nav.clearAppBadge === 'function') {
    void nav.clearAppBadge().catch(() => {});
    return;
  }

  void nav.setAppBadge(0).catch(() => {});
}
