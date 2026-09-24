import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createRef } from 'react';
import { useAbortOnConversationChange } from './useAbortOnConversationChange';

describe('useAbortOnConversationChange', () => {
  it('aborts and clears the request on conversation change', () => {
    const controller = new AbortController();
    const ref = createRef<AbortController | null>();
    ref.current = controller;
    const { rerender } = renderHook(
      ({ key }) => useAbortOnConversationChange(ref, key),
      { initialProps: { key: 'a' } },
    );
    rerender({ key: 'b' });
    expect(controller.signal.aborted).toBe(true);
    expect(ref.current).toBeNull();
  });

  it('does not abort during rerenders with the same conversation key', () => {
    const controller = new AbortController();
    const ref = createRef<AbortController | null>();
    ref.current = controller;
    const { rerender } = renderHook(
      ({ key }) => useAbortOnConversationChange(ref, key),
      { initialProps: { key: 'a' } },
    );
    rerender({ key: 'a' });
    expect(controller.signal.aborted).toBe(false);
  });

  it('aborts on unmount (panel closed while a request is in flight)', () => {
    const controller = new AbortController();
    const ref = createRef<AbortController | null>();
    ref.current = controller;
    const { unmount } = renderHook(
      ({ key }) => useAbortOnConversationChange(ref, key),
      { initialProps: { key: 'a' } },
    );
    unmount();
    expect(controller.signal.aborted).toBe(true);
    expect(ref.current).toBeNull();
  });
});
