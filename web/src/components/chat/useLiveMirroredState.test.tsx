import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useLiveMirroredState } from './useLiveMirroredState';

describe('useLiveMirroredState (bdboard-33jm)', () => {
  it('starts with ref.current already equal to the initial value', () => {
    const { result } = renderHook(() => useLiveMirroredState<Record<string, string>>({}));
    expect(result.current.value).toEqual({});
    expect(result.current.ref.current).toEqual({});
  });

  it('accepts a plain value like setState', () => {
    const { result } = renderHook(() => useLiveMirroredState(0));
    act(() => result.current.set(1));
    expect(result.current.value).toBe(1);
    expect(result.current.ref.current).toBe(1);
  });

  it('accepts an updater function like setState, computed from the live ref (not a stale render prop)', () => {
    const { result } = renderHook(() => useLiveMirroredState(0));
    act(() => result.current.set((prev) => prev + 1));
    act(() => result.current.set((prev) => prev + 1));
    expect(result.current.value).toBe(2);
    expect(result.current.ref.current).toBe(2);
  });

  it('reflects every set() synchronously on ref.current even before React re-renders (the bug this replaces)', () => {
    const { result } = renderHook(() => useLiveMirroredState<string[]>([]));
    // このアサーションが本題: 同じ act() の中で2回 set() を呼んだ直後、
    // renderHook の再レンダーを1回も挟まなくても ref.current は両方の更新を
    // 反映している。旧パターン(フック本体トップレベルで `ref.current = state`
    // する render-mirror)では、2回目の set() が読む「前の値」が最初の
    // set() 分を含まない stale な値になり得た。
    act(() => {
      result.current.set((prev) => [...prev, 'a']);
      result.current.set((prev) => [...prev, 'b']);
    });
    expect(result.current.ref.current).toEqual(['a', 'b']);
    expect(result.current.value).toEqual(['a', 'b']);
  });

  it('keeps a stable set() identity across renders (safe to put in a useCallback dependency array)', () => {
    const { result, rerender } = renderHook(() => useLiveMirroredState(0));
    const firstSet = result.current.set;
    act(() => result.current.set(1));
    rerender();
    expect(result.current.set).toBe(firstSet);
  });
});
