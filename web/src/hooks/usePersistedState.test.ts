import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePersistedState } from './usePersistedState';

const STORAGE_KEY = 'bdboard.test.usePersistedState';

function validateStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  if (!value.every((item) => typeof item === 'string')) {
    return null;
  }
  return value;
}

function dispatchStorageEvent(
  key: string,
  newValue: string | null,
  storageArea: Storage = localStorage,
): void {
  window.dispatchEvent(
    new StorageEvent('storage', {
      key,
      newValue,
      storageArea,
    }),
  );
}

describe('usePersistedState', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('reads the initial value from localStorage on mount', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(['ticket-a']));

    const { result } = renderHook(() =>
      usePersistedState(STORAGE_KEY, [], validateStringArray),
    );

    expect(result.current[0]).toEqual(['ticket-a']);
  });

  it('writes updates to localStorage', () => {
    const { result } = renderHook(() =>
      usePersistedState(STORAGE_KEY, [], validateStringArray),
    );

    act(() => {
      result.current[1](['ticket-b']);
    });

    expect(result.current[0]).toEqual(['ticket-b']);
    expect(localStorage.getItem(STORAGE_KEY)).toBe(JSON.stringify(['ticket-b']));
  });

  it('does not write when the setter leaves the value unchanged', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const { result } = renderHook(() =>
      usePersistedState(STORAGE_KEY, [], validateStringArray),
    );

    act(() => {
      result.current[1]((prev) => prev);
    });

    expect(setItem).not.toHaveBeenCalled();
    setItem.mockRestore();
  });

  it('reflects storage events from other tabs without writing back', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const { result } = renderHook(() =>
      usePersistedState(STORAGE_KEY, [], validateStringArray),
    );

    act(() => {
      dispatchStorageEvent(STORAGE_KEY, JSON.stringify(['ticket-c']));
    });

    await waitFor(() => {
      expect(result.current[0]).toEqual(['ticket-c']);
    });
    expect(setItem).not.toHaveBeenCalled();
    setItem.mockRestore();
  });

  it('ignores storage events for other keys', async () => {
    const { result } = renderHook(() =>
      usePersistedState(STORAGE_KEY, [], validateStringArray),
    );

    act(() => {
      dispatchStorageEvent('bdboard.test.other-key', JSON.stringify(['ticket-d']));
    });

    await waitFor(() => {
      expect(result.current[0]).toEqual([]);
    });
  });

  it('ignores invalid JSON in storage events', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(['ticket-a']));
    const { result } = renderHook(() =>
      usePersistedState(STORAGE_KEY, [], validateStringArray),
    );

    act(() => {
      dispatchStorageEvent(STORAGE_KEY, '{not-json');
    });

    await waitFor(() => {
      expect(result.current[0]).toEqual(['ticket-a']);
    });
  });

  it('ignores storage values that fail validation', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(['ticket-a']));
    const { result } = renderHook(() =>
      usePersistedState(STORAGE_KEY, [], validateStringArray),
    );

    act(() => {
      dispatchStorageEvent(STORAGE_KEY, JSON.stringify([1, 2, 3]));
    });

    await waitFor(() => {
      expect(result.current[0]).toEqual(['ticket-a']);
    });
  });

  it('resets to the default when another tab clears the key', async () => {
    const { result } = renderHook(() =>
      usePersistedState(STORAGE_KEY, [], validateStringArray),
    );

    act(() => {
      result.current[1](['ticket-e']);
    });

    act(() => {
      dispatchStorageEvent(STORAGE_KEY, null);
    });

    await waitFor(() => {
      expect(result.current[0]).toEqual([]);
    });
  });
});
