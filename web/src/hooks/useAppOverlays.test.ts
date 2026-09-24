import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useAppOverlays } from './useAppOverlays';

describe('useAppOverlays', () => {
  it('starts with every overlay closed and the documented default tokens', () => {
    const { result } = renderHook(() => useAppOverlays(null));

    expect(result.current.detailMaximized).toBe(false);
    expect(result.current.searchOpen).toBe(false);
    expect(result.current.shortcutsOpen).toBe(false);
    expect(result.current.helpOpen).toBe(false);
    expect(result.current.chatOpen).toBe(false);
    expect(result.current.chatContext).toBeUndefined();
    expect(result.current.chatContextToken).toBe(0);
    expect(result.current.sessionListOpen).toBe(false);
    expect(result.current.sessionListProjectId).toBeUndefined();
    expect(result.current.tunnelModalOpen).toBe(false);
    expect(result.current.statusDetailOpen).toBe(false);
    expect(result.current.presetSaveIntentToken).toBe(0);
  });

  it('handleToggleDetailMaximized flips detailMaximized', () => {
    const { result } = renderHook(() => useAppOverlays('t-1'));

    act(() => {
      result.current.handleToggleDetailMaximized();
    });
    expect(result.current.detailMaximized).toBe(true);

    act(() => {
      result.current.handleToggleDetailMaximized();
    });
    expect(result.current.detailMaximized).toBe(false);
  });

  it('resets detailMaximized when selectedTicketId becomes null', () => {
    const { result, rerender } = renderHook(
      ({ selectedTicketId }: { selectedTicketId: string | null }) =>
        useAppOverlays(selectedTicketId),
      { initialProps: { selectedTicketId: 't-1' as string | null } },
    );

    act(() => {
      result.current.handleToggleDetailMaximized();
    });
    expect(result.current.detailMaximized).toBe(true);

    rerender({ selectedTicketId: null });
    expect(result.current.detailMaximized).toBe(false);
  });

  it('does not reset detailMaximized while selectedTicketId stays non-null', () => {
    const { result, rerender } = renderHook(
      ({ selectedTicketId }: { selectedTicketId: string | null }) =>
        useAppOverlays(selectedTicketId),
      { initialProps: { selectedTicketId: 't-1' as string | null } },
    );

    act(() => {
      result.current.handleToggleDetailMaximized();
    });
    expect(result.current.detailMaximized).toBe(true);

    rerender({ selectedTicketId: 't-2' });
    expect(result.current.detailMaximized).toBe(true);
  });

  it('handleOpenSearch/handleCloseSearch toggle searchOpen', () => {
    const { result } = renderHook(() => useAppOverlays(null));

    act(() => {
      result.current.handleOpenSearch();
    });
    expect(result.current.searchOpen).toBe(true);

    act(() => {
      result.current.handleCloseSearch();
    });
    expect(result.current.searchOpen).toBe(false);
  });

  it('handleOpenShortcuts/handleCloseShortcuts toggle shortcutsOpen', () => {
    const { result } = renderHook(() => useAppOverlays(null));

    act(() => {
      result.current.handleOpenShortcuts();
    });
    expect(result.current.shortcutsOpen).toBe(true);

    act(() => {
      result.current.handleCloseShortcuts();
    });
    expect(result.current.shortcutsOpen).toBe(false);
  });

  it('handleOpenHelp/handleCloseHelp toggle helpOpen', () => {
    const { result } = renderHook(() => useAppOverlays(null));

    act(() => {
      result.current.handleOpenHelp();
    });
    expect(result.current.helpOpen).toBe(true);

    act(() => {
      result.current.handleCloseHelp();
    });
    expect(result.current.helpOpen).toBe(false);
  });

  it('handleOpenChat opens chat without touching chatContext/chatContextToken', () => {
    const { result } = renderHook(() => useAppOverlays(null));

    act(() => {
      result.current.handleOpenChat();
    });

    expect(result.current.chatOpen).toBe(true);
    expect(result.current.chatContext).toBeUndefined();
    expect(result.current.chatContextToken).toBe(0);
  });

  it('handleChatAboutTicket opens chat with the context and increments the token', () => {
    const { result } = renderHook(() => useAppOverlays(null));

    act(() => {
      result.current.handleChatAboutTicket({ projectId: 'p-1', ticketId: 't-1' });
    });
    expect(result.current.chatOpen).toBe(true);
    expect(result.current.chatContext).toEqual({ projectId: 'p-1', ticketId: 't-1' });
    expect(result.current.chatContextToken).toBe(1);

    act(() => {
      result.current.handleChatAboutTicket({ projectId: 'p-2', ticketId: 't-2' });
    });
    expect(result.current.chatContext).toEqual({ projectId: 'p-2', ticketId: 't-2' });
    expect(result.current.chatContextToken).toBe(2);
  });

  it('handleCloseChat closes chat and clears chatContext (but not the token)', () => {
    const { result } = renderHook(() => useAppOverlays(null));

    act(() => {
      result.current.handleChatAboutTicket({ projectId: 'p-1', ticketId: 't-1' });
    });
    act(() => {
      result.current.handleCloseChat();
    });

    expect(result.current.chatOpen).toBe(false);
    expect(result.current.chatContext).toBeUndefined();
    expect(result.current.chatContextToken).toBe(1);
  });

  it('handleOpenSessionList sets sessionListProjectId from its argument (or clears it when omitted)', () => {
    const { result } = renderHook(() => useAppOverlays(null));

    act(() => {
      result.current.handleOpenSessionList('proj-9');
    });
    expect(result.current.sessionListOpen).toBe(true);
    expect(result.current.sessionListProjectId).toBe('proj-9');

    act(() => {
      result.current.handleCloseSessionList();
    });
    expect(result.current.sessionListOpen).toBe(false);
    expect(result.current.sessionListProjectId).toBeUndefined();

    act(() => {
      result.current.handleOpenSessionList();
    });
    expect(result.current.sessionListProjectId).toBeUndefined();
  });

  it('handleOpenTunnel/handleCloseTunnel toggle tunnelModalOpen', () => {
    const { result } = renderHook(() => useAppOverlays(null));

    act(() => {
      result.current.handleOpenTunnel();
    });
    expect(result.current.tunnelModalOpen).toBe(true);

    act(() => {
      result.current.handleCloseTunnel();
    });
    expect(result.current.tunnelModalOpen).toBe(false);
  });

  it('handleOpenStatusDetail opens statusDetailOpen and setStatusDetailOpen sets it directly', () => {
    const { result } = renderHook(() => useAppOverlays(null));

    act(() => {
      result.current.handleOpenStatusDetail();
    });
    expect(result.current.statusDetailOpen).toBe(true);

    act(() => {
      result.current.setStatusDetailOpen(false);
    });
    expect(result.current.statusDetailOpen).toBe(false);
  });

  it('handleSaveProjectCombination increments presetSaveIntentToken each call', () => {
    const { result } = renderHook(() => useAppOverlays(null));

    act(() => {
      result.current.handleSaveProjectCombination();
    });
    expect(result.current.presetSaveIntentToken).toBe(1);

    act(() => {
      result.current.handleSaveProjectCombination();
    });
    expect(result.current.presetSaveIntentToken).toBe(2);
  });
});
