import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { acquireSharedEventSource } from './lib/sseConnection';

export type StreamState = 'connecting' | 'open' | 'error';

export interface BoardStreamResult {
  state: StreamState;
  lastContactAtMs: number | null;
}

// Lower bound between two "revalidate everything" passes triggered by the
// visibilitychange guard below. Keeps a flurry of tab focus/blur events (or a
// focus event racing an EventSource reconnect that just fired the same
// invalidation) from hammering the API with duplicate refetches.
const MIN_REVALIDATE_INTERVAL_MS = 5000;

// State へのコミット間隔。touchContact は「前回コミットから quantum 経過後の最初の接触」で
// 必ずコミットするので、committed 値の遅れの上限は quantum 未満（<30秒）。遅れる向きは常に
// 「committed <= 実際の最終接触」＝バナーが早めに出る安全側で、遅延判定閾値（120秒）に対して
// 十分小さい。
const CONTACT_COMMIT_QUANTUM_MS = 30_000;

export function useBoardStream(): BoardStreamResult {
  const queryClient = useQueryClient();
  const [state, setState] = useState<StreamState>('connecting');
  const [lastContactAtMs, setLastContactAtMs] = useState<number | null>(null);
  const lastCommittedContactAtRef = useRef<number | null>(null);

  useEffect(() => {
    const conn = acquireSharedEventSource();
    lastCommittedContactAtRef.current = null;

    const touchContact = () => {
      const now = Date.now();
      const lastCommitted = lastCommittedContactAtRef.current;
      if (lastCommitted === null || now - lastCommitted >= CONTACT_COMMIT_QUANTUM_MS) {
        lastCommittedContactAtRef.current = now;
        setLastContactAtMs(now);
      }
    };

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

    const onOpen = () => {
      setState('open');
      touchContact();
      if (hadErrorRef.current) {
        hadErrorRef.current = false;
        revalidateAll();
      }
    };

    const onError = () => {
      setState('error');
      hadErrorRef.current = true;
    };

    conn.addOpenListener(onOpen);
    conn.addErrorListener(onError);

    const onBoardChanged = () => {
      touchContact();
      void queryClient.invalidateQueries({ queryKey: ['board'] });
      void queryClient.invalidateQueries({ queryKey: ['status'] });
      // .beads の変更を検知した = チケット本文やコメントも変わりうる
      void queryClient.invalidateQueries({ queryKey: ['ticket'] });
      void queryClient.invalidateQueries({ queryKey: ['ticket-comments'] });
      void queryClient.invalidateQueries({ queryKey: ['pending-decisions'] });
      void queryClient.invalidateQueries({ queryKey: ['pr-links'] });
    };

    const onSessionChanged = () => {
      touchContact();
      void queryClient.invalidateQueries({ queryKey: ['sessions'] });
      void queryClient.invalidateQueries({ queryKey: ['board'] });
      void queryClient.invalidateQueries({ queryKey: ['projects'] });
    };

    conn.addEventListener('board.changed', onBoardChanged);
    conn.addEventListener('session.changed', onSessionChanged);
    conn.addEventListener('ping', touchContact);
    conn.addEventListener('hello', touchContact);

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
      conn.removeEventListener('board.changed', onBoardChanged);
      conn.removeEventListener('session.changed', onSessionChanged);
      conn.removeEventListener('ping', touchContact);
      conn.removeEventListener('hello', touchContact);
      conn.removeOpenListener(onOpen);
      conn.removeErrorListener(onError);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      conn.release();
    };
  }, [queryClient]);

  return { state, lastContactAtMs };
}
