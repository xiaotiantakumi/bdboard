import { renderHook } from '@testing-library/react';
import { StrictMode, type ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { useMountedRef } from './useMountedRef';

describe('useMountedRef', () => {
  it('is true while mounted and false after unmount', () => {
    const { result, unmount } = renderHook(() => useMountedRef());
    const mounted = result.current;
    expect(mounted.current).toBe(true);
    unmount();
    expect(mounted.current).toBe(false);
  });

  it('is true again after the StrictMode double effect (clean up, then run again)', () => {
    const wrapper = ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode>;
    const { result } = renderHook(() => useMountedRef(), { wrapper });
    expect(result.current.current).toBe(true);
  });
});
