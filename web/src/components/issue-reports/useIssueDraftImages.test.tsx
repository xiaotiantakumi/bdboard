import { act, renderHook } from '@testing-library/react';
import type { ClipboardEvent } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ISSUE_DRAFT_IMAGE_MAX_BYTES } from './issueDraftImageLimits';
import { useIssueDraftImages } from './useIssueDraftImages';

function file(name: string, type = 'image/png'): File {
  return new File(['x'], name, { type });
}

interface PasteOptions {
  /** clipboardData.types。既定は、ファイルがあれば ['Files']、無ければ空 (画像だけをコピーしたとき)。 */
  readonly types?: string[];
  /** getData('text/plain') が返す文字。既定は空。 */
  readonly text?: string;
  /** 貼り付け先。既定は文字の欄ではない要素 (フォームの余白)。 */
  readonly target?: EventTarget;
}

/** onPaste が受ける形のイベント (clipboardData の files・types・getData と、target、preventDefault だけを使う)。 */
function pasteEvent(files: File[], options: PasteOptions = {}) {
  const preventDefault = vi.fn();
  const clipboardData = {
    files,
    types: options.types ?? (files.length > 0 ? ['Files'] : []),
    getData: (type: string) => (type === 'text/plain' ? (options.text ?? '') : ''),
  };
  const target = options.target ?? document.createElement('div');
  const event = { clipboardData, target, preventDefault } as unknown as ClipboardEvent<HTMLElement>;
  return { event, preventDefault };
}

function inputOfType(type: string): HTMLInputElement {
  const input = document.createElement('input');
  input.type = type;
  return input;
}

/** Excel・Word が載せる形 (文字と HTML と画像が一度に入る)。実機の形式はブラウザで未確認 (docs/ISSUE-REPORTING.md の逸脱表)。 */
const OFFICE_TYPES = ['text/plain', 'text/html', 'Files'];

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

  // bdboard-8zwi: 付けた・外したを読み上げに届ける文。
  describe('notice (for the screen reader)', () => {
    it('starts empty', () => {
      const { result } = renderHook(() => useIssueDraftImages());
      expect(result.current.notice).toBe('');
    });

    it('says how many images were attached and how many there are now', () => {
      const { result } = renderHook(() => useIssueDraftImages());
      act(() => result.current.addFiles([file('a.png'), file('b.png')]));
      expect(result.current.notice).toBe('2 枚の画像を付けました (全部で 2 枚)。');
      act(() => result.current.addFiles([file('c.png')]));
      expect(result.current.notice).toBe('1 枚の画像を付けました (全部で 3 枚)。');
    });

    it('counts only the images that were really attached, not the refused ones', () => {
      const { result } = renderHook(() => useIssueDraftImages());
      act(() => result.current.addFiles([file('ok.png'), file('vector.svg', 'image/svg+xml')]));
      expect(result.current.notice).toBe('1 枚の画像を付けました (全部で 1 枚)。');
    });

    it('is empty when nothing was attached (the refusal is read out by the alert instead)', () => {
      const { result } = renderHook(() => useIssueDraftImages());
      act(() => result.current.addFiles([file('a.png')]));
      act(() => result.current.addFiles([file('vector.svg', 'image/svg+xml')]));
      expect(result.current.notice).toBe('');
      expect(result.current.problems).toHaveLength(1);
    });

    it('names the image that was taken off and how many are left', () => {
      const { result } = renderHook(() => useIssueDraftImages());
      act(() => result.current.addFiles([file('a.png'), file('b.png')]));
      act(() => result.current.remove(result.current.images[0]?.id ?? ''));
      expect(result.current.notice).toBe('「a.png」を外しました (全部で 1 枚)。');
    });

    it('is empty when the image to take off is not there', () => {
      const { result } = renderHook(() => useIssueDraftImages());
      act(() => result.current.addFiles([file('a.png')]));
      act(() => result.current.remove('no-such-id'));
      expect(result.current.notice).toBe('');
    });

    it('announces an image attached by a paste too', () => {
      const { result } = renderHook(() => useIssueDraftImages());
      const { event } = pasteEvent([file('paste.png')]);
      act(() => result.current.handlePaste(event));
      expect(result.current.notice).toBe('1 枚の画像を付けました (全部で 1 枚)。');
    });
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

    // bdboard-8zwi: Excel・Word は、文字と画像を一度にクリップボードへ載せる。文字の欄に貼るときは、画像ではなく文字を入れる。
    describe('when the clipboard carries both text and an image', () => {
      it.each([
        ['the description (textarea)', () => document.createElement('textarea')],
        ['the title (input type=text)', () => inputOfType('text')],
        ['a search input', () => inputOfType('search')],
      ])('leaves the paste to the browser in %s, so the text goes in and no image is attached', (_label, makeTarget) => {
        const { result } = renderHook(() => useIssueDraftImages());
        const { event, preventDefault } = pasteEvent([file('cells.png')], {
          types: OFFICE_TYPES,
          text: 'a\tb\n1\t2',
          target: makeTarget(),
        });
        act(() => result.current.handlePaste(event));
        expect(preventDefault).not.toHaveBeenCalled();
        expect(result.current.images).toEqual([]);
        expect(result.current.problems).toEqual([]);
      });

      it.each([
        ['the margin of the form', () => document.createElement('div')],
        ['a button', () => document.createElement('button')],
        ['a file input', () => inputOfType('file')],
        ['a checkbox', () => inputOfType('checkbox')],
      ])('attaches the image when pasted onto %s (there is no text field to take the text)', (_label, makeTarget) => {
        const { result } = renderHook(() => useIssueDraftImages());
        const { event, preventDefault } = pasteEvent([file('cells.png')], {
          types: OFFICE_TYPES,
          text: 'a\tb',
          target: makeTarget(),
        });
        act(() => result.current.handlePaste(event));
        expect(preventDefault).toHaveBeenCalledTimes(1);
        expect(result.current.images.map((image) => image.name)).toEqual(['cells.png']);
      });

      it('still attaches an image-only paste (a screenshot) into a text field', () => {
        const { result } = renderHook(() => useIssueDraftImages());
        const { event, preventDefault } = pasteEvent([file('shot.png')], {
          types: ['Files'],
          target: document.createElement('textarea'),
        });
        act(() => result.current.handlePaste(event));
        expect(preventDefault).toHaveBeenCalledTimes(1);
        expect(result.current.images.map((image) => image.name)).toEqual(['shot.png']);
      });

      // Chrome の「画像をコピー」は <img> だけの HTML と画像を載せ、文字は無い。HTML があるだけで文字を優先すると、画像が付かず何も貼られない。
      it('still attaches an image copied from a web page (HTML with only an <img>, no text) into a text field', () => {
        const { result } = renderHook(() => useIssueDraftImages());
        const { event, preventDefault } = pasteEvent([file('page.png')], {
          types: ['text/html', 'Files'],
          target: document.createElement('textarea'),
        });
        act(() => result.current.handlePaste(event));
        expect(preventDefault).toHaveBeenCalledTimes(1);
        expect(result.current.images.map((image) => image.name)).toEqual(['page.png']);
      });

      it('does not count a text/plain that is only whitespace as text', () => {
        const { result } = renderHook(() => useIssueDraftImages());
        const { event, preventDefault } = pasteEvent([file('chart.png')], {
          types: OFFICE_TYPES,
          text: ' \n',
          target: document.createElement('textarea'),
        });
        act(() => result.current.handlePaste(event));
        expect(preventDefault).toHaveBeenCalledTimes(1);
        expect(result.current.images.map((image) => image.name)).toEqual(['chart.png']);
      });
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
