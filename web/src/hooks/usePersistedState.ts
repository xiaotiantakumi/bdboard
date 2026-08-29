import { useCallback, useEffect, useRef, useState } from 'react';

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

function readValidatedStorageValue<T>(
  raw: string,
  validate: PersistedValidator<T>,
): T | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return validate(parsed);
  } catch {
    return null;
  }
}

function parseStoredValue<T>(
  raw: string | null,
  defaultValue: T,
  validate: PersistedValidator<T>,
): T {
  if (raw === null) {
    return defaultValue;
  }
  return readValidatedStorageValue(raw, validate) ?? defaultValue;
}

export type PersistedValidator<T> = (value: unknown) => T | null;

export function usePersistedState<T>(
  key: string,
  defaultValue: T,
  validate: PersistedValidator<T>,
): [T, (value: T | ((prev: T) => T)) => void] {
  const defaultValueRef = useRef(defaultValue);
  defaultValueRef.current = defaultValue;
  const validateRef = useRef(validate);
  validateRef.current = validate;

  const [state, setState] = useState<T>(() =>
    parseStoredValue(readStorageItem(key), defaultValue, validate),
  );

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const handleStorage = (event: StorageEvent) => {
      if (event.storageArea !== getStorage()) {
        return;
      }
      if (event.key !== key) {
        return;
      }
      if (event.newValue === null) {
        const next = defaultValueRef.current;
        setState((prev) => (Object.is(next, prev) ? prev : next));
        return;
      }
      const next = readValidatedStorageValue(event.newValue, validateRef.current);
      if (next === null) {
        return;
      }
      setState((prev) => (Object.is(next, prev) ? prev : next));
    };

    window.addEventListener('storage', handleStorage);
    return () => {
      window.removeEventListener('storage', handleStorage);
    };
  }, [key]);

  const setPersistedState = useCallback(
    (value: T | ((prev: T) => T)) => {
      setState((prev) => {
        const next = typeof value === 'function' ? (value as (prev: T) => T)(prev) : value;
        /*
          値が変わっていないときは書かない。起動のたびに走る正規化 effect
          (App.tsx のプロジェクト絞り込みの sanitize など)が、実際には何も変えて
          いないのに localStorage へ書き込んでしまうと、「この端末にはまだ絞り込みが
          保存されていない」という判定 (hasStoredBoardFilterState) が初回起動でも
          true になり、既定プリセットの自動適用が永久に発火しなくなる。
        */
        if (Object.is(next, prev)) {
          return prev;
        }
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
