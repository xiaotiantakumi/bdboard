import { useCallback, useEffect, useRef, useState } from 'react';
import { boardHashTarget, parseBoardHash, type BoardHashState } from '../boardHash';
import type { ViewMode } from '../uiPersistedState';

export interface UseTicketDeepLinkOptions {
  view: ViewMode;
  onViewChange: (view: ViewMode) => void;
}

export interface TicketDeepLink {
  selectedTicketId: string | null;
  selectTicket: (ticketId: string) => void;
  closeDetail: () => void;
}

function readHistoryState(): Record<string, unknown> {
  const state = window.history.state;
  if (state !== null && typeof state === 'object') {
    return { ...(state as Record<string, unknown>) };
  }
  return {};
}

export function useTicketDeepLink({
  view,
  onViewChange,
}: UseTicketDeepLinkOptions): TicketDeepLink {
  // Parsed once, on the first render only: the hash is re-read from then on by
  // the popstate/hashchange listener, never by re-parsing during render.
  const initialHashRef = useRef<BoardHashState | null>(null);
  if (initialHashRef.current === null) {
    initialHashRef.current = parseBoardHash(window.location.hash);
  }
  const initialHash = initialHashRef.current;

  const [selectedTicketId, setSelectedTicketId] = useState<string | null>(
    () => initialHash.ticketId,
  );
  const pendingHashViewRef = useRef<ViewMode | null>(initialHash.view);
  const detailPushedRef = useRef(false);
  const selectedTicketIdRef = useRef<string | null>(initialHash.ticketId);

  const viewRef = useRef(view);
  viewRef.current = view;

  const onViewChangeRef = useRef(onViewChange);
  onViewChangeRef.current = onViewChange;

  selectedTicketIdRef.current = selectedTicketId;

  // Apply view from the initial hash without letting the sync effect overwrite it
  // with the stale persisted view (merged) first.
  useEffect(() => {
    const pending = pendingHashViewRef.current;
    if (pending === null) {
      return;
    }
    if (pending === view) {
      pendingHashViewRef.current = null;
      return;
    }
    onViewChangeRef.current(pending);
  }, [view]);

  // Keep the URL hash in sync (replaceState only — no extra history entries).
  useEffect(() => {
    const effectiveView = pendingHashViewRef.current ?? view;
    const target = boardHashTarget(
      { ticketId: selectedTicketId, view: effectiveView },
      window.location,
    );
    const current =
      window.location.pathname + window.location.search + window.location.hash;
    if (target === current) {
      return;
    }
    window.history.replaceState(window.history.state, '', target);
  }, [view, selectedTicketId]);

  const selectTicket = useCallback((ticketId: string) => {
    const target = boardHashTarget(
      { ticketId, view: viewRef.current },
      window.location,
    );
    const state = { ...readHistoryState(), ticketId };

    if (selectedTicketIdRef.current === null) {
      window.history.pushState(state, '', target);
      detailPushedRef.current = true;
    } else {
      window.history.replaceState(state, '', target);
    }
    setSelectedTicketId(ticketId);
  }, []);

  const closeDetail = useCallback(() => {
    if (detailPushedRef.current) {
      window.history.back();
    } else {
      setSelectedTicketId(null);
    }
  }, []);

  useEffect(() => {
    const onLocationChange = () => {
      const next = parseBoardHash(window.location.hash);
      // Keep detailPushedRef true while the hash still carries a ticket — e.g.
      // when a child panel (ChatPanel / SessionListPanel via useHistoryBackClose)
      // pops its own entry, we must not lose track of the detail entry we pushed.
      // Previously App closed the detail panel on every popstate unconditionally,
      // which broke that case; the hash is now the source of truth.
      detailPushedRef.current =
        detailPushedRef.current && next.ticketId !== null;
      setSelectedTicketId(next.ticketId);
      if (next.view !== null && next.view !== viewRef.current) {
        onViewChangeRef.current(next.view);
      }
    };

    window.addEventListener('popstate', onLocationChange);
    window.addEventListener('hashchange', onLocationChange);
    return () => {
      window.removeEventListener('popstate', onLocationChange);
      window.removeEventListener('hashchange', onLocationChange);
    };
  }, []);

  return {
    selectedTicketId,
    selectTicket,
    closeDetail,
  };
}
