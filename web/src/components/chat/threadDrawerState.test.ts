import { describe, expect, it } from 'vitest';
import {
  initialThreadDrawerState,
  threadDrawerReducer,
  type ThreadDrawerState,
} from './threadDrawerState';

describe('threadDrawerReducer (bdboard-sso1.83)', () => {
  it('starts closed with no row interaction', () => {
    expect(initialThreadDrawerState).toEqual({
      drawerOpen: false,
      menuSessionId: null,
      renamingSessionId: null,
      renameDraft: '',
      confirmingDeleteSessionId: null,
      showDiscoveredSessions: false,
    });
  });

  describe('toggleDrawer', () => {
    it('opens the drawer without touching an already-closed menu', () => {
      const next = threadDrawerReducer(initialThreadDrawerState, { type: 'toggleDrawer' });
      expect(next.drawerOpen).toBe(true);
      expect(next.menuSessionId).toBeNull();
    });

    it('closing the drawer also closes any open row menu (旧: threadDrawerOpen useEffect)', () => {
      const opened: ThreadDrawerState = {
        ...initialThreadDrawerState,
        drawerOpen: true,
        menuSessionId: 'session-1',
      };
      const next = threadDrawerReducer(opened, { type: 'toggleDrawer' });
      expect(next.drawerOpen).toBe(false);
      expect(next.menuSessionId).toBeNull();
    });

    it('closing the drawer leaves an in-progress rename/delete-confirm untouched', () => {
      const opened: ThreadDrawerState = {
        ...initialThreadDrawerState,
        drawerOpen: true,
        renamingSessionId: 'session-1',
        renameDraft: 'draft',
        confirmingDeleteSessionId: 'session-2',
      };
      const next = threadDrawerReducer(opened, { type: 'toggleDrawer' });
      expect(next.renamingSessionId).toBe('session-1');
      expect(next.renameDraft).toBe('draft');
      expect(next.confirmingDeleteSessionId).toBe('session-2');
    });
  });

  describe('closeDrawer', () => {
    it('closes the drawer and any open row menu', () => {
      const opened: ThreadDrawerState = {
        ...initialThreadDrawerState,
        drawerOpen: true,
        menuSessionId: 'session-1',
      };
      const next = threadDrawerReducer(opened, { type: 'closeDrawer' });
      expect(next).toEqual({ ...initialThreadDrawerState, drawerOpen: false, menuSessionId: null });
    });

    it('is a no-op (same reference) when already closed with no menu', () => {
      const next = threadDrawerReducer(initialThreadDrawerState, { type: 'closeDrawer' });
      expect(next).toBe(initialThreadDrawerState);
    });
  });

  describe('selectThread', () => {
    it('closes the drawer, menu, rename mode, and delete-confirm mode together', () => {
      const busy: ThreadDrawerState = {
        drawerOpen: true,
        menuSessionId: 'session-1',
        renamingSessionId: 'session-2',
        renameDraft: 'draft',
        confirmingDeleteSessionId: 'session-3',
        showDiscoveredSessions: true,
      };
      const next = threadDrawerReducer(busy, { type: 'selectThread' });
      expect(next.drawerOpen).toBe(false);
      expect(next.menuSessionId).toBeNull();
      expect(next.renamingSessionId).toBeNull();
      expect(next.confirmingDeleteSessionId).toBeNull();
      // renameDraft (text) and showDiscoveredSessions are not part of this combo.
      expect(next.renameDraft).toBe('draft');
      expect(next.showDiscoveredSessions).toBe(true);
    });

    it('is a no-op (same reference) when nothing to clear', () => {
      const next = threadDrawerReducer(initialThreadDrawerState, { type: 'selectThread' });
      expect(next).toBe(initialThreadDrawerState);
    });
  });

  describe('toggleMenu', () => {
    it('opens the menu for a session with no menu open', () => {
      const next = threadDrawerReducer(initialThreadDrawerState, {
        type: 'toggleMenu',
        sessionId: 'session-1',
      });
      expect(next.menuSessionId).toBe('session-1');
    });

    it('closes the menu when toggled again for the same session', () => {
      const opened: ThreadDrawerState = { ...initialThreadDrawerState, menuSessionId: 'session-1' };
      const next = threadDrawerReducer(opened, { type: 'toggleMenu', sessionId: 'session-1' });
      expect(next.menuSessionId).toBeNull();
    });

    it('switches the menu to a different session (only one open at a time)', () => {
      const opened: ThreadDrawerState = { ...initialThreadDrawerState, menuSessionId: 'session-1' };
      const next = threadDrawerReducer(opened, { type: 'toggleMenu', sessionId: 'session-2' });
      expect(next.menuSessionId).toBe('session-2');
    });
  });

  describe('closeMenu', () => {
    it('closes an open menu', () => {
      const opened: ThreadDrawerState = { ...initialThreadDrawerState, menuSessionId: 'session-1' };
      expect(threadDrawerReducer(opened, { type: 'closeMenu' }).menuSessionId).toBeNull();
    });

    it('is a no-op (same reference) when already closed', () => {
      const next = threadDrawerReducer(initialThreadDrawerState, { type: 'closeMenu' });
      expect(next).toBe(initialThreadDrawerState);
    });
  });

  describe('startRename', () => {
    it('opens rename mode with the given draft and closes the menu + delete-confirm', () => {
      const busy: ThreadDrawerState = {
        ...initialThreadDrawerState,
        menuSessionId: 'session-1',
        confirmingDeleteSessionId: 'session-1',
      };
      const next = threadDrawerReducer(busy, {
        type: 'startRename',
        sessionId: 'session-1',
        initialDraft: 'タイトル',
      });
      expect(next.renamingSessionId).toBe('session-1');
      expect(next.renameDraft).toBe('タイトル');
      expect(next.menuSessionId).toBeNull();
      expect(next.confirmingDeleteSessionId).toBeNull();
    });
  });

  describe('changeRenameDraft', () => {
    it('updates the draft text only', () => {
      const renaming: ThreadDrawerState = {
        ...initialThreadDrawerState,
        renamingSessionId: 'session-1',
        renameDraft: '旧',
      };
      const next = threadDrawerReducer(renaming, { type: 'changeRenameDraft', text: '新' });
      expect(next.renameDraft).toBe('新');
      expect(next.renamingSessionId).toBe('session-1');
    });
  });

  describe('cancelRename', () => {
    it('clears rename mode', () => {
      const renaming: ThreadDrawerState = {
        ...initialThreadDrawerState,
        renamingSessionId: 'session-1',
        renameDraft: 'draft',
      };
      const next = threadDrawerReducer(renaming, { type: 'cancelRename' });
      expect(next.renamingSessionId).toBeNull();
    });

    it('is a no-op (same reference) when not renaming', () => {
      const next = threadDrawerReducer(initialThreadDrawerState, { type: 'cancelRename' });
      expect(next).toBe(initialThreadDrawerState);
    });
  });

  describe('startConfirmDelete / cancelConfirmDelete', () => {
    it('starts delete-confirm mode for a session', () => {
      const next = threadDrawerReducer(initialThreadDrawerState, {
        type: 'startConfirmDelete',
        sessionId: 'session-1',
      });
      expect(next.confirmingDeleteSessionId).toBe('session-1');
    });

    it('cancels delete-confirm mode', () => {
      const confirming: ThreadDrawerState = {
        ...initialThreadDrawerState,
        confirmingDeleteSessionId: 'session-1',
      };
      expect(
        threadDrawerReducer(confirming, { type: 'cancelConfirmDelete' }).confirmingDeleteSessionId,
      ).toBeNull();
    });

    it('cancelConfirmDelete is a no-op (same reference) when nothing is confirming', () => {
      const next = threadDrawerReducer(initialThreadDrawerState, { type: 'cancelConfirmDelete' });
      expect(next).toBe(initialThreadDrawerState);
    });
  });

  describe('cancelInteractionsForSession (旧: handleCloseThread の条件付きクリア)', () => {
    it('clears rename and delete-confirm only when they match the closed session', () => {
      const busy: ThreadDrawerState = {
        ...initialThreadDrawerState,
        renamingSessionId: 'session-1',
        renameDraft: 'draft',
        confirmingDeleteSessionId: 'session-1',
      };
      const next = threadDrawerReducer(busy, {
        type: 'cancelInteractionsForSession',
        sessionId: 'session-1',
      });
      expect(next.renamingSessionId).toBeNull();
      expect(next.confirmingDeleteSessionId).toBeNull();
    });

    it('leaves rename/delete-confirm alone when they belong to a different session', () => {
      const busy: ThreadDrawerState = {
        ...initialThreadDrawerState,
        renamingSessionId: 'session-1',
        confirmingDeleteSessionId: 'session-2',
      };
      const next = threadDrawerReducer(busy, {
        type: 'cancelInteractionsForSession',
        sessionId: 'session-3',
      });
      expect(next).toBe(busy);
    });

    it('clears only the matching one when rename and delete-confirm target different sessions', () => {
      const busy: ThreadDrawerState = {
        ...initialThreadDrawerState,
        renamingSessionId: 'session-1',
        confirmingDeleteSessionId: 'session-2',
      };
      const next = threadDrawerReducer(busy, {
        type: 'cancelInteractionsForSession',
        sessionId: 'session-1',
      });
      expect(next.renamingSessionId).toBeNull();
      expect(next.confirmingDeleteSessionId).toBe('session-2');
    });
  });

  describe('toggleDiscoveredSessions / closeDiscoveredSessions', () => {
    it('toggles the discovered-sessions panel open and closed', () => {
      const opened = threadDrawerReducer(initialThreadDrawerState, {
        type: 'toggleDiscoveredSessions',
      });
      expect(opened.showDiscoveredSessions).toBe(true);
      const closed = threadDrawerReducer(opened, { type: 'toggleDiscoveredSessions' });
      expect(closed.showDiscoveredSessions).toBe(false);
    });

    it('closeDiscoveredSessions closes it unconditionally', () => {
      const opened: ThreadDrawerState = { ...initialThreadDrawerState, showDiscoveredSessions: true };
      expect(
        threadDrawerReducer(opened, { type: 'closeDiscoveredSessions' }).showDiscoveredSessions,
      ).toBe(false);
    });

    it('closeDiscoveredSessions is a no-op (same reference) when already closed', () => {
      const next = threadDrawerReducer(initialThreadDrawerState, { type: 'closeDiscoveredSessions' });
      expect(next).toBe(initialThreadDrawerState);
    });
  });
});
