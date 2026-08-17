import { useCallback, useState } from 'react';

function getStorage(): Storage | null {
  try {
    if (typeof localStorage === 'undefined') {
      return null;
    }
    return localStorage;
  } catch {
    return null;
  }
}

function readStorageItem(key: string): string | null {
  try {
    const storage = getStorage();
    if (storage === null) {
      return null;
    }
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorageItem(key: string, value: string): void {
  try {
    const storage = getStorage();
    if (storage === null) {
      return;
    }
    storage.setItem(key, value);
  } catch {
    // localStorage unavailable (private browsing quota, etc.)
  }
}

export type PersistedValidator<T> = (value: unknown) => T | null;

export function usePersistedState<T>(
  key: string,
  defaultValue: T,
  validate: PersistedValidator<T>,
): [T, (value: T | ((prev: T) => T)) => void] {
  const [state, setState] = useState<T>(() => {
    try {
      const raw = readStorageItem(key);
      if (raw === null) {
        return defaultValue;
      }
      const parsed: unknown = JSON.parse(raw);
      const validated = validate(parsed);
      return validated ?? defaultValue;
    } catch {
      return defaultValue;
    }
  });

  const setPersistedState = useCallback(
    (value: T | ((prev: T) => T)) => {
      setState((prev) => {
        const next = typeof value === 'function' ? (value as (prev: T) => T)(prev) : value;
        try {
          writeStorageItem(key, JSON.stringify(next));
        } catch {
          // ignore write failures
        }
        return next;
      });
    },
    [key],
  );

  return [state, setPersistedState];
}
