import { fireEvent, render, screen } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useFocusTrap } from './useFocusTrap';

function FocusTrapFixture({
  enabled = true,
  useInitialFocusRef = true,
  onEscape,
  hidden,
}: {
  enabled?: boolean;
  useInitialFocusRef?: boolean;
  onEscape?: () => void;
  /** 「Last」の後ろに、指定の隠し方で隠したボタンを1つ足す(bdboard-77k)。 */
  hidden?: 'display-none' | 'visibility-hidden' | 'hidden-attribute' | 'inside-hidden-parent';
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const initialFocusRef = useRef<HTMLButtonElement>(null);

  useFocusTrap({
    containerRef,
    initialFocusRef: useInitialFocusRef ? initialFocusRef : undefined,
    enabled,
    onEscape,
  });

  return (
    <div>
      <button type="button">Outside</button>
      <div ref={containerRef} tabIndex={-1} data-testid="trap-container">
        <button type="button">First</button>
        <button ref={initialFocusRef} type="button">
          Initial
        </button>
        <button type="button">Last</button>
        {hidden === 'display-none' && (
          <button type="button" style={{ display: 'none' }}>
            Hidden
          </button>
        )}
        {hidden === 'visibility-hidden' && (
          <button type="button" style={{ visibility: 'hidden' }}>
            Hidden
          </button>
        )}
        {hidden === 'hidden-attribute' && (
          <button type="button" hidden>
            Hidden
          </button>
        )}
        {hidden === 'inside-hidden-parent' && (
          <div style={{ display: 'none' }}>
            <button type="button">Hidden</button>
          </div>
        )}
      </div>
    </div>
  );
}

function FocusTrapFixtureHiddenFirst() {
  const containerRef = useRef<HTMLDivElement>(null);
  useFocusTrap({ containerRef });

  return (
    <div ref={containerRef} tabIndex={-1}>
      <button type="button" style={{ display: 'none' }}>
        Hidden
      </button>
      <button type="button">Visible</button>
    </div>
  );
}

function FocusTrapFixtureAllHidden() {
  const containerRef = useRef<HTMLDivElement>(null);
  useFocusTrap({ containerRef });

  return (
    <div ref={containerRef} tabIndex={-1} data-testid="trap-container">
      <button type="button" style={{ display: 'none' }}>
        Hidden
      </button>
    </div>
  );
}

describe('useFocusTrap', () => {
  let rafCallbacks: FrameRequestCallback[];

  beforeEach(() => {
    rafCallbacks = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      rafCallbacks.push(callback);
      return rafCallbacks.length;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('focuses initialFocusRef synchronously even when rAF never fires', () => {
    render(<FocusTrapFixture />);

    expect(screen.getByRole('button', { name: 'Initial' })).toHaveFocus();
    expect(rafCallbacks).toHaveLength(0);
  });

  it('focuses the first focusable element when initialFocusRef is omitted', () => {
    render(<FocusTrapFixture useInitialFocusRef={false} />);

    expect(screen.getByRole('button', { name: 'First' })).toHaveFocus();
    expect(rafCallbacks).toHaveLength(0);
  });

  it('calls onEscape when rAF never fires', () => {
    const onEscape = vi.fn();
    render(<FocusTrapFixture onEscape={onEscape} />);

    expect(screen.getByRole('button', { name: 'Initial' })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });

    expect(onEscape).toHaveBeenCalledTimes(1);
    expect(rafCallbacks).toHaveLength(0);
  });

  it('restores focus to the element that was active before enabling the trap', () => {
    const outside = document.createElement('button');
    outside.type = 'button';
    outside.textContent = 'Previous';
    document.body.appendChild(outside);
    outside.focus();

    const { unmount } = render(<FocusTrapFixture />);

    expect(screen.getByRole('button', { name: 'Initial' })).toHaveFocus();

    unmount();

    expect(outside).toHaveFocus();
    outside.remove();
  });

  describe('CSSで隠れた要素の除外 (bdboard-77k)', () => {
    // セレクタは disabled と tabindex="-1" しか見ないので、CSS で消しただけの
    // ボタンが Tab の巡回に残る。実例はチャットパネルの「最大化」(幅700px以下)。
    it.each([
      ['display-none'],
      ['visibility-hidden'],
      ['hidden-attribute'],
      ['inside-hidden-parent'],
    ] as const)('wraps past a control hidden by %s', (hidden) => {
      render(<FocusTrapFixture hidden={hidden} />);

      const last = screen.getByRole('button', { name: 'Last' });
      last.focus();
      fireEvent.keyDown(last, { key: 'Tab' });

      // 隠しボタンが最後だと見なされていれば、Tab は折り返さずここで止まる。
      expect(screen.getByRole('button', { name: 'First' })).toHaveFocus();
    });

    it('does not pick a hidden control as the initial focus target', () => {
      render(
        <FocusTrapFixtureHiddenFirst />,
      );

      expect(screen.getByRole('button', { name: 'Visible' })).toHaveFocus();
    });

    it('still traps Tab when every focusable control is hidden', () => {
      render(<FocusTrapFixtureAllHidden />);

      const container = screen.getByTestId('trap-container');
      // フォーカスがコンテナの外(初期フォーカス先が無いので body のまま)にある
      // 状態の Tab は「先頭へ引き戻す」経路に入る。巡回先が1つも無いまま
      // そこへ進むと undefined を触って落ちる。
      expect(document.activeElement).toBe(document.body);
      expect(() => fireEvent.keyDown(container, { key: 'Tab' })).not.toThrow();
    });
  });
});
