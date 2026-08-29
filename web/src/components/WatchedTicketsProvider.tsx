import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  type ReactNode,
} from 'react';
import {
  UI_STORAGE_KEYS,
  validateWatchedTicketIds,
} from '../uiPersistedState';
import { usePersistedState } from '../hooks/usePersistedState';

export interface WatchedTicketsContextValue {
  readonly watchedIds: readonly string[];
  readonly watchedSet: ReadonlySet<string>;
  readonly isWatched: (ticketId: string) => boolean;
  readonly toggleWatch: (ticketId: string) => void;
  readonly stopWatching: (ticketId: string) => void;
}

const WatchedTicketsContext = createContext<WatchedTicketsContextValue | null>(null);

export function useWatchedTickets(): WatchedTicketsContextValue {
  const value = useContext(WatchedTicketsContext);
  if (value === null) {
    throw new Error('useWatchedTickets must be used within WatchedTicketsProvider');
  }
  return value;
}

export function WatchedTicketsProvider({ children }: { children: ReactNode }) {
  const [watchedIds, setWatchedIds] = usePersistedState<string[]>(
    UI_STORAGE_KEYS.watchedTicketIds,
    [],
    validateWatchedTicketIds,
  );

  const watchedSet = useMemo(() => new Set(watchedIds), [watchedIds]);

  const isWatched = useCallback(
    (ticketId: string) => watchedSet.has(ticketId),
    [watchedSet],
  );

  const toggleWatch = useCallback(
    (ticketId: string) => {
      setWatchedIds((current) => {
        if (current.includes(ticketId)) {
          return current.filter((id) => id !== ticketId);
        }
        return [...current, ticketId];
      });
    },
    [setWatchedIds],
  );

  const stopWatching = useCallback(
    (ticketId: string) => {
      setWatchedIds((current) => current.filter((id) => id !== ticketId));
    },
    [setWatchedIds],
  );

  const value = useMemo(
    (): WatchedTicketsContextValue => ({
      watchedIds,
      watchedSet,
      isWatched,
      toggleWatch,
      stopWatching,
    }),
    [watchedIds, watchedSet, isWatched, toggleWatch, stopWatching],
  );

  return (
    <WatchedTicketsContext.Provider value={value}>
      {children}
    </WatchedTicketsContext.Provider>
  );
}
