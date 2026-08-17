import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

export type StreamState = 'connecting' | 'open' | 'error';

// Lower bound between two "revalidate everything" passes triggered by the
// visibilitychange guard below. Keeps a flurry of tab focus/blur events (or a
// focus event racing an EventSource reconnect that just fired the same
// invalidation) from hammering the API with duplicate refetches.
const MIN_REVALIDATE_INTERVAL_MS = 5000;

export function useBoardStream(): StreamState {
  const queryClient = useQueryClient();
  const [state, setState] = useState<StreamState>('connecting');

  useEffect(() => {
    // Absolute, built from origin rather than the relative '/api/events': a
    // relative URL resolves against the document URL, and if that still carries
    // QR credentials WebKit rejects the EventSource outright. `origin` never
    // includes userinfo, so this holds even if the history rewrite in main.tsx
    // did not run. See stripUrlCredentials.ts.
    const es = new EventSource(`${window.location.origin}/api/events`);

    // Tracks whether the connection has been through an error/disconnect
    // since the effect mounted (or since the last successful revalidation).
    // Any change that happened while we were disconnected only reaches us as
    // a fresh SSE event *after* reconnecting, so a reconnect after an error
    // has to be treated the same as an explicit board.changed/session.changed
    // — otherwise the UI keeps showing stale data until the next live event.
    const hadErrorRef = { current: false };
    const lastRevalidateAtRef = { current: 0 };

    const revalidateAll = () => {
      onBoardChanged();
      onSessionChanged();
      lastRevalidateAtRef.current = Date.now();
    };

    es.onopen = () => {
      setState('open');
      if (hadErrorRef.current) {
        hadErrorRef.current = false;
        revalidateAll();
      }
    };

    es.onerror = () => {
      setState('error');
      hadErrorRef.current = true;
    };

    const onBoardChanged = () => {
      void queryClient.invalidateQueries({ queryKey: ['board'] });
      void queryClient.invalidateQueries({ queryKey: ['status'] });
      // .beads の変更を検知した = チケット本文やコメントも変わりうる
      void queryClient.invalidateQueries({ queryKey: ['ticket'] });
      void queryClient.invalidateQueries({ queryKey: ['ticket-comments'] });
      void queryClient.invalidateQueries({ queryKey: ['pending-decisions'] });
    };

    const onSessionChanged = () => {
      void queryClient.invalidateQueries({ queryKey: ['sessions'] });
      void queryClient.invalidateQueries({ queryKey: ['board'] });
      void queryClient.invalidateQueries({ queryKey: ['projects'] });
    };

    es.addEventListener('board.changed', onBoardChanged);
    es.addEventListener('session.changed', onSessionChanged);

    // Mobile PWAs frequently freeze/kill the SSE connection when backgrounded
    // without ever firing onerror — the socket just silently stops delivering
    // events. Coming back to the foreground is the only observable signal we
    // get in that case, so treat it as a possible-missed-update too, guarded
    // by MIN_REVALIDATE_INTERVAL_MS to avoid piling on top of a reconnect
    // that already revalidated moments earlier.
    const onVisibilityChange = () => {
      if (document.visibilityState !== 'visible') return;
      if (Date.now() - lastRevalidateAtRef.current < MIN_REVALIDATE_INTERVAL_MS) return;
      revalidateAll();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      es.removeEventListener('board.changed', onBoardChanged);
      es.removeEventListener('session.changed', onSessionChanged);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      es.close();
    };
  }, [queryClient]);

  return state;
}
