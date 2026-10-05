import { act, renderHook } from '@testing-library/react';
import type { ClipboardEvent } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ISSUE_DRAFT_IMAGE_MAX_BYTES } from './issueDraftImageLimits';
import { useIssueDraftImages } from './useIssueDraftImages';

function file(name: string, type = 'image/png'): File {
  return new File(['x'], name, { type });
}

/** onPaste が受ける形のイベント (clipboardData.files と preventDefault だけを使う)。 */
function pasteEvent(files: File[]) {
  const preventDefault = vi.fn();
  const event = { clipboardData: { files }, preventDefault } as unknown as ClipboardEvent<HTMLElement>;
  return { event, preventDefault };
}

describe('useIssueDraftImages (bdboard-4y8q.6.9)', () => {
  it('starts with nothing attached and no problems', () => {
    const { result } = renderHook(() => useIssueDraftImages());
    expect(result.current.images).toEqual([]);
    expect(result.current.problems).toEqual([]);
  });

  it('adds files in order with unique ids, keeping the File objects', () => {
    const { result } = renderHook(() => useIssueDraftImages());
    const first = file('a.png');
    const second = file('b.png');
    act(() => result.current.addFiles([first, second]));
    expect(result.current.images.map((image) => image.name)).toEqual(['a.png', 'b.png']);
    expect(result.current.images[0]?.file).toBe(first);
    expect(result.current.images[1]?.file).toBe(second);
    expect(new Set(result.current.images.map((image) => image.id)).size).toBe(2);
  });

  it('does not reuse an id after an image was removed', () => {
    const { result } = renderHook(() => useIssueDraftImages());
    act(() => result.current.addFiles([file('a.png')]));
    const firstId = result.current.images[0]?.id ?? '';
    act(() => result.current.remove(firstId));
    act(() => result.current.addFiles([file('b.png')]));
    expect(result.current.images).toHaveLength(1);
    expect(result.current.images[0]?.id).not.toBe(firstId);
  });

  it('gives a file with no name a numbered placeholder', () => {
    const { result } = renderHook(() => useIssueDraftImages());
    act(() => result.current.addFiles([file('')]));
    expect(result.current.images[0]?.name).toBe('貼り付け画像 1');
  });

  it('counts the limit across calls made before the next render', () => {
    const { result } = renderHook(() => useIssueDraftImages());
    act(() => {
      result.current.addFiles(Array.from({ length: 12 }, (_, index) => file(`first-${index}.png`)));
      result.current.addFiles(Array.from({ length: 12 }, (_, index) => file(`second-${index}.png`)));
    });
    expect(result.current.images).toHaveLength(20);
    expect(result.current.images.at(-1)?.name).toBe('second-7.png');
    expect(result.current.problems).toEqual([
      '画像は 20 枚までです。次の画像は付けませんでした: 「second-8.png」「second-9.png」「second-10.png」「second-11.png」',
    ]);
  });

  it('keeps the valid images and reports the refused ones in the same call', () => {
    const { result } = renderHook(() => useIssueDraftImages());
    act(() =>
      result.current.addFiles([
        file('ok.png'),
        file('vector.svg', 'image/svg+xml'),
        new File([new Uint8Array(ISSUE_DRAFT_IMAGE_MAX_BYTES + 1)], 'big.png', { type: 'image/png' }),
      ]),
    );
    expect(result.current.images.map((image) => image.name)).toEqual(['ok.png']);
    expect(result.current.problems).toHaveLength(2);
    expect(result.current.problems[0]).toContain('vector.svg');
    expect(result.current.problems[1]).toContain('big.png');
  });

  it('replaces the problems on the next add, and clears them when an add has none', () => {
    const { result } = renderHook(() => useIssueDraftImages());
    act(() => result.current.addFiles([file('bad.svg', 'image/svg+xml')]));
    expect(result.current.problems).toHaveLength(1);
    act(() => result.current.addFiles([file('other.svg', 'image/svg+xml')]));
    expect(result.current.problems).toHaveLength(1);
    expect(result.current.problems[0]).toContain('other.svg');
    act(() => result.current.addFiles([file('good.png')]));
    expect(result.current.problems).toEqual([]);
  });

  it('removes one image by id and clears the problems', () => {
    const { result } = renderHook(() => useIssueDraftImages());
    act(() => result.current.addFiles([file('a.png'), file('b.png'), file('c.png')]));
    act(() => result.current.addFiles([file('bad.svg', 'image/svg+xml')]));
    expect(result.current.problems).toHaveLength(1);
    const middle = result.current.images[1]?.id ?? '';
    act(() => result.current.remove(middle));
    expect(result.current.images.map((image) => image.name)).toEqual(['a.png', 'c.png']);
    expect(result.current.problems).toEqual([]);
  });

  it('frees a slot when an image is removed, so a full list can take another', () => {
    const { result } = renderHook(() => useIssueDraftImages());
    act(() => result.current.addFiles(Array.from({ length: 20 }, (_, index) => file(`${index}.png`))));
    act(() => result.current.remove(result.current.images[0]?.id ?? ''));
    act(() => result.current.addFiles([file('again.png')]));
    expect(result.current.images).toHaveLength(20);
    expect(result.current.problems).toEqual([]);
  });

  describe('handlePaste', () => {
    it('takes the image files from the clipboard and stops the browser default', () => {
      const { result } = renderHook(() => useIssueDraftImages());
      const { event, preventDefault } = pasteEvent([file('paste.png')]);
      act(() => result.current.handlePaste(event));
      expect(preventDefault).toHaveBeenCalledTimes(1);
      expect(result.current.images.map((image) => image.name)).toEqual(['paste.png']);
    });

    it('leaves a text-only paste to the browser', () => {
      const { result } = renderHook(() => useIssueDraftImages());
      const { event, preventDefault } = pasteEvent([]);
      act(() => result.current.handlePaste(event));
      expect(preventDefault).not.toHaveBeenCalled();
      expect(result.current.images).toEqual([]);
      expect(result.current.problems).toEqual([]);
    });

    it('ignores files that are not images (and leaves the paste alone)', () => {
      const { result } = renderHook(() => useIssueDraftImages());
      const { event, preventDefault } = pasteEvent([file('notes.pdf', 'application/pdf')]);
      act(() => result.current.handlePaste(event));
      expect(preventDefault).not.toHaveBeenCalled();
      expect(result.current.images).toEqual([]);
      expect(result.current.problems).toEqual([]);
    });

    it('takes an image of a format the server would refuse and says why, instead of dropping it silently', () => {
      const { result } = renderHook(() => useIssueDraftImages());
      const { event, preventDefault } = pasteEvent([file('vector.svg', 'image/svg+xml')]);
      act(() => result.current.handlePaste(event));
      expect(preventDefault).toHaveBeenCalledTimes(1);
      expect(result.current.images).toEqual([]);
      expect(result.current.problems[0]).toContain('「vector.svg」は付けられません');
    });

    it('takes only the images when text files and images are pasted together', () => {
      const { result } = renderHook(() => useIssueDraftImages());
      const { event } = pasteEvent([file('notes.pdf', 'application/pdf'), file('shot.png')]);
      act(() => result.current.handlePaste(event));
      expect(result.current.images.map((image) => image.name)).toEqual(['shot.png']);
      expect(result.current.problems).toEqual([]);
    });
  });
});
