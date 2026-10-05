import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useIssueDraftImages } from './useIssueDraftImages';

const file = (name: string, type = 'image/png') => new File(['x'], name, { type });

describe('useIssueDraftImages', () => {
  it('adds files with unique ids', () => {
    const { result } = renderHook(() => useIssueDraftImages());
    act(() => result.current.addFiles([file('a.png'), file('b.png')]));
    expect(result.current.images).toHaveLength(2);
    expect(new Set(result.current.images.map((image) => image.id)).size).toBe(2);
  });
  it('names empty files with their selection sequence', () => {
    const { result } = renderHook(() => useIssueDraftImages());
    act(() => result.current.addFiles([file('')]));
    expect(result.current.images[0]?.name).toBe('貼り付け画像 1');
  });
  it('keeps consecutive additions within the 20 image limit', () => {
    const { result } = renderHook(() => useIssueDraftImages());
    act(() => {
      result.current.addFiles(Array.from({ length: 12 }, (_, index) => file(`${index}.png`)));
      result.current.addFiles(Array.from({ length: 12 }, (_, index) => file(`next-${index}.png`)));
    });
    expect(result.current.images).toHaveLength(20);
    expect(result.current.problems[0]).toContain('next-11.png');
  });
  it('replaces problems on the next add and clears them on remove', () => {
    const { result } = renderHook(() => useIssueDraftImages());
    act(() => result.current.addFiles([file('bad.svg', 'image/svg+xml')]));
    expect(result.current.problems).toHaveLength(1);
    act(() => result.current.addFiles([file('good.png')]));
    expect(result.current.problems).toEqual([]);
    act(() => result.current.addFiles([file('bad-again.svg', 'image/svg+xml')]));
    act(() => result.current.remove(result.current.images[0]!.id));
    expect(result.current.images).toEqual([]);
    expect(result.current.problems).toEqual([]);
  });
  it('pastes image files and prevents the browser default', () => {
    const { result } = renderHook(() => useIssueDraftImages());
    const preventDefault = vi.fn();
    act(() => result.current.handlePaste({ clipboardData: { files: [file('paste.png') ] }, preventDefault } as never));
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(result.current.images).toHaveLength(1);
  });
  it('leaves plain text paste alone', () => {
    const { result } = renderHook(() => useIssueDraftImages());
    const preventDefault = vi.fn();
    act(() => result.current.handlePaste({ clipboardData: { files: [] }, preventDefault } as never));
    expect(preventDefault).not.toHaveBeenCalled();
    expect(result.current.images).toEqual([]);
  });
  it('shows a rejection when a pasted image MIME is unsupported', () => {
    const { result } = renderHook(() => useIssueDraftImages());
    act(() => result.current.handlePaste({ clipboardData: { files: [file('vector.svg', 'image/svg+xml')] }, preventDefault: vi.fn() } as never));
    expect(result.current.problems[0]).toContain('付けられる形式');
  });
});
