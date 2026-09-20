import { useCallback, useEffect, useRef, type RefObject } from 'react';
import { UI_STORAGE_KEYS, validateBoolean } from '../../uiPersistedState';
import { usePersistedState } from '../usePersistedState';

export interface UseNotificationPermissionResult {
  readonly notificationsEnabled: boolean;
  /**
   * バッチ配送 (flushNotificationBatch / enqueueBrowserNotification) が
   * effect の再登録を挟まず最新値を読むための ref。state 本体は
   * notificationsEnabled 側にあり、この ref は同期用の複製。
   */
  readonly notificationsEnabledRef: RefObject<boolean>;
  readonly notificationsSupported: boolean;
  readonly permission: NotificationPermission | 'unsupported';
  readonly enableNotifications: () => Promise<void>;
  readonly disableNotifications: () => void;
}

export function useNotificationPermission(): UseNotificationPermissionResult {
  const [notificationsEnabled, setNotificationsEnabled] = usePersistedState(
    UI_STORAGE_KEYS.notificationsEnabled,
    false,
    validateBoolean,
  );
  const notificationsEnabledRef = useRef(notificationsEnabled);

  useEffect(() => {
    notificationsEnabledRef.current = notificationsEnabled;
  }, [notificationsEnabled]);

  const enableNotifications = useCallback(async () => {
    if (typeof Notification === 'undefined') {
      return;
    }
    if (Notification.permission === 'granted') {
      setNotificationsEnabled(true);
      return;
    }
    if (Notification.permission === 'denied') {
      return;
    }
    const result = await Notification.requestPermission();
    if (result === 'granted') {
      setNotificationsEnabled(true);
    }
  }, [setNotificationsEnabled]);

  const disableNotifications = useCallback(() => {
    setNotificationsEnabled(false);
  }, [setNotificationsEnabled]);

  const notificationsSupported = typeof Notification !== 'undefined';
  const permission = notificationsSupported ? Notification.permission : 'unsupported';

  return {
    notificationsEnabled,
    notificationsEnabledRef,
    notificationsSupported,
    permission,
    enableNotifications,
    disableNotifications,
  };
}
