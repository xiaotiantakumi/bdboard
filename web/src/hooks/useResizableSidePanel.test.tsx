import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SidePanelResizeHandle,
  useResizableSidePanel,
  validateSidePanelWidth,
} from './useResizableSidePanel';

const STORAGE_KEY = 'bdboard.test.sidePanelWidth';

function TestPanel({ storageKey = STORAGE_KEY }: { storageKey?: string }) {
  const panel = useResizableSidePanel(storageKey);
  return (
    <div>
      <div data-testid="panel" style={{ width: `${panel.width}px` }} />
      <SidePanelResizeHandle label="パネルの幅を変更" panel={panel} />
    </div>
  );
}

function getHandle() {
  return screen.getByRole('separator', { name: 'パネルの幅を変更' });
}

function getPanelWidth() {
  const panel = screen.getByTestId('panel');
  return panel.style.width;
}

describe('useResizableSidePanel', () => {
  beforeEach(() => {
    localStorage.clear();
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1000 });
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('validates persisted widths within [360, 720]', () => {
    expect(validateSidePanelWidth(360)).toBe(360);
    expect(validateSidePanelWidth(720)).toBe(720);
    expect(validateSidePanelWidth(359)).toBeNull();
    expect(validateSidePanelWidth(721)).toBeNull();
    expect(validateSidePanelWidth(500.5)).toBeNull();
    expect(validateSidePanelWidth('500')).toBeNull();
  });

  it('writes to localStorage exactly once per drag (pointerdown -> multiple pointermove -> pointerup)', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    render(<TestPanel />);
    const handle = getHandle();

    expect(getPanelWidth()).toBe('480px');

    fireEvent(handle, new MouseEvent('pointerdown', { bubbles: true, clientX: 500 }));
    fireEvent(handle, new MouseEvent('pointermove', { bubbles: true, clientX: 480 }));
    fireEvent(handle, new MouseEvent('pointermove', { bubbles: true, clientX: 460 }));
    fireEvent(handle, new MouseEvent('pointermove', { bubbles: true, clientX: 440 }));
    fireEvent(handle, new MouseEvent('pointermove', { bubbles: true, clientX: 420 }));

    // ドラッグ中(pointermoveのたび)は localStorage へ書き込まない。
    expect(setItem).not.toHaveBeenCalled();
    // 見た目の幅は追従する: 500 - 420 = 80 移動した分だけ増える。
    expect(getPanelWidth()).toBe('560px');

    fireEvent(handle, new MouseEvent('pointerup', { bubbles: true }));

    // pointerup で確定したときにだけ1回書き込む。
    expect(setItem).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(STORAGE_KEY)).toBe('560');

    setItem.mockRestore();
  });

  it('does not jump the width on pointerdown when the pointer position differs from the handle', () => {
    render(<TestPanel />);
    const handle = getHandle();

    expect(getPanelWidth()).toBe('480px');

    // 実際のハンドル位置とはかけ離れたクリック位置でも、pointerdown 単体では
    // 幅が変わらない(旧実装は window.innerWidth - clientX から幅を再計算し
    // 瞬間的に跳んでいた)。
    fireEvent(handle, new MouseEvent('pointerdown', { bubbles: true, clientX: 999 }));
    expect(getPanelWidth()).toBe('480px');
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('clamps the width to MIN_WIDTH/MAX_WIDTH while dragging', () => {
    render(<TestPanel />);
    const handle = getHandle();

    fireEvent(handle, new MouseEvent('pointerdown', { bubbles: true, clientX: 500 }));
    // 大きく右へ動かす -> 最小幅でクランプされる。
    fireEvent(handle, new MouseEvent('pointermove', { bubbles: true, clientX: 5000 }));
    expect(getPanelWidth()).toBe('360px');

    // 大きく左へ動かす -> 最大幅(720px、あるいは viewport 由来のクランプ)でクランプされる。
    fireEvent(handle, new MouseEvent('pointermove', { bubbles: true, clientX: -5000 }));
    expect(getPanelWidth()).toBe('680px'); // viewportMaximum = 1000 - 320 = 680 < MAX_WIDTH(720)

    fireEvent(handle, new MouseEvent('pointerup', { bubbles: true }));
    expect(localStorage.getItem(STORAGE_KEY)).toBe('680');
  });

  it('cancels the drag on pointercancel without persisting the in-progress width', () => {
    render(<TestPanel />);
    const handle = getHandle();

    fireEvent(handle, new MouseEvent('pointerdown', { bubbles: true, clientX: 500 }));
    fireEvent(handle, new MouseEvent('pointermove', { bubbles: true, clientX: 300 }));
    expect(getPanelWidth()).toBe('680px');

    fireEvent(handle, new MouseEvent('pointercancel', { bubbles: true }));

    // pointercancel でも確定させる(既存のpointerup相当の挙動を維持)。
    expect(localStorage.getItem(STORAGE_KEY)).toBe('680');
  });

  it('does nothing when the viewport is too narrow to resize', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 600 });
    render(<TestPanel />);
    const handle = getHandle();

    fireEvent(handle, new MouseEvent('pointerdown', { bubbles: true, clientX: 500 }));
    fireEvent(handle, new MouseEvent('pointermove', { bubbles: true, clientX: 100 }));
    expect(getPanelWidth()).toBe('480px');
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();

    fireEvent(handle, new MouseEvent('pointerup', { bubbles: true }));
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('supports keyboard resizing and persists immediately on each keypress', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    render(<TestPanel />);
    const handle = getHandle();

    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    expect(getPanelWidth()).toBe('500px');
    expect(localStorage.getItem(STORAGE_KEY)).toBe('500');

    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(getPanelWidth()).toBe('480px');
    expect(localStorage.getItem(STORAGE_KEY)).toBe('480');

    fireEvent.keyDown(handle, { key: 'Home' });
    expect(getPanelWidth()).toBe('360px');
    expect(localStorage.getItem(STORAGE_KEY)).toBe('360');

    fireEvent.keyDown(handle, { key: 'End' });
    expect(getPanelWidth()).toBe('680px'); // viewportMaximum = 1000 - 320 = 680
    expect(localStorage.getItem(STORAGE_KEY)).toBe('680');

    // 矢印キーごとに書き込みが発生する(キー入力は60Hzに達しないためバッチ不要)。
    expect(setItem).toHaveBeenCalledTimes(4);

    setItem.mockRestore();
  });

  it('ignores keyboard resizing when the viewport is too narrow', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 600 });
    render(<TestPanel />);
    const handle = getHandle();

    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    expect(getPanelWidth()).toBe('480px');
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('reads the persisted width on mount', () => {
    localStorage.setItem(STORAGE_KEY, '600');
    render(<TestPanel />);
    expect(getPanelWidth()).toBe('600px');
  });

  it('reacts to storage events from another tab without writing back', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    render(<TestPanel />);

    act(() => {
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: STORAGE_KEY,
          newValue: '600',
          storageArea: localStorage,
        }),
      );
    });

    expect(getPanelWidth()).toBe('600px');
    expect(setItem).not.toHaveBeenCalled();

    setItem.mockRestore();
  });
});
