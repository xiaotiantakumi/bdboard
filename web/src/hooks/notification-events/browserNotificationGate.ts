function shouldSuppressBrowserNotification(): boolean {
  return document.visibilityState === 'visible' && document.hasFocus();
}

export function passesBrowserNotificationGate(notificationsEnabled: boolean): boolean {
  if (typeof Notification === 'undefined') {
    return false;
  }
  if (Notification.permission !== 'granted') {
    return false;
  }
  if (!notificationsEnabled) {
    return false;
  }
  if (shouldSuppressBrowserNotification()) {
    return false;
  }
  return true;
}
