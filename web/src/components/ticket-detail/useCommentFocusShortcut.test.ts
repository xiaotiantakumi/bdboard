import { describe, expect, it, vi } from 'vitest';
import type { KeyboardEvent, RefObject } from 'react';
import { useCommentFocusShortcut } from './useCommentFocusShortcut';

// TicketDetailPanel.tsx のパネル外枠 div に付いていた 'c' キーボード
// ショートカット(コメント入力欄へフォーカス)を抽出したフック。抽出前は
// インラインの onKeyDown ハンドラで、専用のテストが無かった
// (TicketDetailPanel.test.tsx にもこのショートカットのテストは存在しない)。
// ここでは判定ロジックの各分岐を直接固定する。このフックは React の
// use* API を呼ばないプレーンな関数なので renderHook は使わず、素の関数
// 呼び出しとしてテストする。

function makeEvent(
  overrides: Partial<{
    defaultPrevented: boolean;
    metaKey: boolean;
    ctrlKey: boolean;
    altKey: boolean;
    shiftKey: boolean;
    key: string;
    target: EventTarget;
    // vi.fn() で直接渡す (event.preventDefault という unbound-method
    // アクセスを避けるため、呼び出し側はこの変数を直接 assert する)。
    preventDefault: () => void;
  }> = {},
): KeyboardEvent<HTMLDivElement> {
  return {
    defaultPrevented: false,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    key: 'c',
    target: document.createElement('div'),
    preventDefault: vi.fn(),
    ...overrides,
  } as unknown as KeyboardEvent<HTMLDivElement>;
}

function makeTextareaRef(
  textarea: HTMLTextAreaElement | null,
): RefObject<HTMLTextAreaElement | null> {
  return { current: textarea };
}

describe('useCommentFocusShortcut', () => {
  it('focuses and scrolls the comment textarea for a plain "c" press when eligible', () => {
    const textarea = document.createElement('textarea');
    const focusSpy = vi.spyOn(textarea, 'focus');
    // jsdom は scrollIntoView を実装していないので、テスト用にスタブする。
    const scrollIntoViewSpy = vi.fn();
    textarea.scrollIntoView = scrollIntoViewSpy;
    const preventDefaultSpy = vi.fn();
    const handleKeyDown = useCommentFocusShortcut({
      textareaRef: makeTextareaRef(textarea),
      disabled: false,
    });
    const event = makeEvent({ preventDefault: preventDefaultSpy });

    handleKeyDown(event);

    expect(preventDefaultSpy).toHaveBeenCalledTimes(1);
    expect(focusSpy).toHaveBeenCalledTimes(1);
    expect(scrollIntoViewSpy).toHaveBeenCalledWith({ block: 'nearest' });
  });

  it('does not throw when scrollIntoView is unavailable (jsdom default)', () => {
    const textarea = document.createElement('textarea');
    const focusSpy = vi.spyOn(textarea, 'focus');
    const handleKeyDown = useCommentFocusShortcut({
      textareaRef: makeTextareaRef(textarea),
      disabled: false,
    });

    expect(() => handleKeyDown(makeEvent())).not.toThrow();
    expect(focusSpy).toHaveBeenCalledTimes(1);
  });

  it('ignores the event when defaultPrevented is already true', () => {
    const textarea = document.createElement('textarea');
    const focusSpy = vi.spyOn(textarea, 'focus');
    const handleKeyDown = useCommentFocusShortcut({
      textareaRef: makeTextareaRef(textarea),
      disabled: false,
    });

    handleKeyDown(makeEvent({ defaultPrevented: true }));

    expect(focusSpy).not.toHaveBeenCalled();
  });

  it.each(['metaKey', 'ctrlKey', 'altKey', 'shiftKey'] as const)(
    'ignores "c" when %s modifier is held',
    (modifier) => {
      const textarea = document.createElement('textarea');
      const focusSpy = vi.spyOn(textarea, 'focus');
      const handleKeyDown = useCommentFocusShortcut({
        textareaRef: makeTextareaRef(textarea),
        disabled: false,
      });

      handleKeyDown(makeEvent({ [modifier]: true }));

      expect(focusSpy).not.toHaveBeenCalled();
    },
  );

  it('ignores keys other than "c"', () => {
    const textarea = document.createElement('textarea');
    const focusSpy = vi.spyOn(textarea, 'focus');
    const handleKeyDown = useCommentFocusShortcut({
      textareaRef: makeTextareaRef(textarea),
      disabled: false,
    });

    handleKeyDown(makeEvent({ key: 'v' }));

    expect(focusSpy).not.toHaveBeenCalled();
  });

  it.each(['INPUT', 'TEXTAREA', 'SELECT'])(
    'ignores "c" typed while focus is already inside a form element (%s)',
    (tagName) => {
      const textarea = document.createElement('textarea');
      const focusSpy = vi.spyOn(textarea, 'focus');
      const handleKeyDown = useCommentFocusShortcut({
        textareaRef: makeTextareaRef(textarea),
        disabled: false,
      });
      const target = document.createElement(tagName.toLowerCase());

      handleKeyDown(makeEvent({ target }));

      expect(focusSpy).not.toHaveBeenCalled();
    },
  );

  it('ignores "c" typed inside a contentEditable element', () => {
    const textarea = document.createElement('textarea');
    const focusSpy = vi.spyOn(textarea, 'focus');
    const handleKeyDown = useCommentFocusShortcut({
      textareaRef: makeTextareaRef(textarea),
      disabled: false,
    });
    const target = document.createElement('div');
    Object.defineProperty(target, 'isContentEditable', { value: true });

    handleKeyDown(makeEvent({ target }));

    expect(focusSpy).not.toHaveBeenCalled();
  });

  it('ignores the shortcut while disabled (quick action / agent run confirmation open)', () => {
    const textarea = document.createElement('textarea');
    const focusSpy = vi.spyOn(textarea, 'focus');
    const handleKeyDown = useCommentFocusShortcut({
      textareaRef: makeTextareaRef(textarea),
      disabled: true,
    });

    handleKeyDown(makeEvent());

    expect(focusSpy).not.toHaveBeenCalled();
  });

  it('does nothing when the textarea ref is not attached yet', () => {
    const handleKeyDown = useCommentFocusShortcut({
      textareaRef: makeTextareaRef(null),
      disabled: false,
    });

    expect(() => handleKeyDown(makeEvent())).not.toThrow();
  });

  it('does nothing when the textarea is disabled', () => {
    const textarea = document.createElement('textarea');
    textarea.disabled = true;
    const focusSpy = vi.spyOn(textarea, 'focus');
    const handleKeyDown = useCommentFocusShortcut({
      textareaRef: makeTextareaRef(textarea),
      disabled: false,
    });

    handleKeyDown(makeEvent());

    expect(focusSpy).not.toHaveBeenCalled();
  });

  it('returns a fresh handler function on every call (matches the original per-render inline closure)', () => {
    const textarea = document.createElement('textarea');
    const options = { textareaRef: makeTextareaRef(textarea), disabled: false };

    const first = useCommentFocusShortcut(options);
    const second = useCommentFocusShortcut(options);

    expect(first).not.toBe(second);
  });
});
