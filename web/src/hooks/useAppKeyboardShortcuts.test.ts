import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  useAppKeyboardShortcuts,
  type AppKeyboardShortcutsParams,
} from './useAppKeyboardShortcuts';

function baseParams(
  overrides: Partial<AppKeyboardShortcutsParams> = {},
): AppKeyboardShortcutsParams {
  return {
    helpOpen: false,
    tunnelModalOpen: false,
    chatOpen: false,
    searchOpen: false,
    sessionListOpen: false,
    shortcutsOpen: false,
    selectedTicketId: null,
    onOpenSearch: vi.fn(),
    onOpenShortcuts: vi.fn(),
    onCloseShortcuts: vi.fn(),
    ...overrides,
  };
}

function fireKeydown(init: KeyboardEventInit) {
  document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...init }));
}

describe('useAppKeyboardShortcuts', () => {
  it('opens the search palette on Cmd+K', () => {
    const params = baseParams();
    renderHook(() => useAppKeyboardShortcuts(params));

    fireKeydown({ key: 'k', metaKey: true });

    expect(params.onOpenSearch).toHaveBeenCalledTimes(1);
  });

  it('opens the search palette on Ctrl+K too', () => {
    const params = baseParams();
    renderHook(() => useAppKeyboardShortcuts(params));

    fireKeydown({ key: 'K', ctrlKey: true });

    expect(params.onOpenSearch).toHaveBeenCalledTimes(1);
  });

  it('does not open search when help is open', () => {
    const params = baseParams({ helpOpen: true });
    renderHook(() => useAppKeyboardShortcuts(params));

    fireKeydown({ key: 'k', metaKey: true });

    expect(params.onOpenSearch).not.toHaveBeenCalled();
  });

  it('does not open search when the tunnel modal is open', () => {
    const params = baseParams({ tunnelModalOpen: true });
    renderHook(() => useAppKeyboardShortcuts(params));

    fireKeydown({ key: 'k', metaKey: true });

    expect(params.onOpenSearch).not.toHaveBeenCalled();
  });

  it('ignores Cmd+K with an extra modifier (alt/shift)', () => {
    const params = baseParams();
    renderHook(() => useAppKeyboardShortcuts(params));

    fireKeydown({ key: 'k', metaKey: true, shiftKey: true });
    fireKeydown({ key: 'k', metaKey: true, altKey: true });

    expect(params.onOpenSearch).not.toHaveBeenCalled();
  });

  it('opens the shortcuts overlay on "?" when nothing else is open', () => {
    const params = baseParams();
    renderHook(() => useAppKeyboardShortcuts(params));

    fireKeydown({ key: '?' });

    expect(params.onOpenShortcuts).toHaveBeenCalledTimes(1);
  });

  it('closes the shortcuts overlay on "?" when it is already open, without opening it again', () => {
    const params = baseParams({ shortcutsOpen: true });
    renderHook(() => useAppKeyboardShortcuts(params));

    fireKeydown({ key: '?' });

    expect(params.onCloseShortcuts).toHaveBeenCalledTimes(1);
    expect(params.onOpenShortcuts).not.toHaveBeenCalled();
  });

  it.each([
    ['searchOpen', { searchOpen: true }],
    ['helpOpen', { helpOpen: true }],
    ['chatOpen', { chatOpen: true }],
    ['sessionListOpen', { sessionListOpen: true }],
    ['tunnelModalOpen', { tunnelModalOpen: true }],
  ] as const)('does not open shortcuts on "?" while %s is true', (_name, overrides) => {
    const params = baseParams(overrides);
    renderHook(() => useAppKeyboardShortcuts(params));

    fireKeydown({ key: '?' });

    expect(params.onOpenShortcuts).not.toHaveBeenCalled();
  });

  it('does not open shortcuts on "?" while a ticket is selected', () => {
    const params = baseParams({ selectedTicketId: 't-1' });
    renderHook(() => useAppKeyboardShortcuts(params));

    fireKeydown({ key: '?' });

    expect(params.onOpenShortcuts).not.toHaveBeenCalled();
  });

  it('ignores "?" chords with a modifier held', () => {
    const params = baseParams();
    renderHook(() => useAppKeyboardShortcuts(params));

    fireKeydown({ key: '?', metaKey: true });

    expect(params.onOpenShortcuts).not.toHaveBeenCalled();
  });

  it('ignores keydowns from typing targets (input elements)', () => {
    const params = baseParams();
    renderHook(() => useAppKeyboardShortcuts(params));

    const input = document.createElement('input');
    document.body.appendChild(input);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: '?', bubbles: true }));
    document.body.removeChild(input);

    expect(params.onOpenSearch).not.toHaveBeenCalled();
    expect(params.onOpenShortcuts).not.toHaveBeenCalled();
  });

  it('removes its listeners on unmount', () => {
    const params = baseParams();
    const { unmount } = renderHook(() => useAppKeyboardShortcuts(params));

    unmount();
    fireKeydown({ key: 'k', metaKey: true });
    fireKeydown({ key: '?' });

    expect(params.onOpenSearch).not.toHaveBeenCalled();
    expect(params.onOpenShortcuts).not.toHaveBeenCalled();
  });
});
