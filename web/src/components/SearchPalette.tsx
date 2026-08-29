import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { searchTickets, type TicketSearchResultDto } from '../api';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { filterPaletteActions, type PaletteAction } from '../paletteActions';
import type { RecentTicketEntry } from '../uiPersistedState';

const DEBOUNCE_MS = 200;
const SEARCH_LIMIT = 30;
const EMPTY_RECENT_TICKETS: RecentTicketEntry[] = [];

type PaletteRow =
  | { kind: 'action'; action: PaletteAction }
  | { kind: 'ticket'; ticket: TicketSearchResultDto }
  | { kind: 'recent'; ticket: RecentTicketEntry };

interface SearchPaletteProps {
  onClose: () => void;
  onSelect: (ticketId: string) => void;
  actions: PaletteAction[];
  recentTickets?: RecentTicketEntry[];
}

export function SearchPalette({
  onClose,
  onSelect,
  actions,
  recentTickets = EMPTY_RECENT_TICKETS,
}: SearchPaletteProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [ticketResults, setTicketResults] = useState<TicketSearchResultDto[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const trimmedQuery = query.trim();
  const hasQuery = trimmedQuery.length > 0;

  // actions は呼び出し元 (App.tsx) の useMemo が毎レンダー新しい参照を返して
  // しまう場合があっても選択行がリセットされないよう、内容(id列)が前回と
  // 同じであれば直前の参照を再利用する保険的な対策 (bdboard-t43h)。
  // 根本原因である呼び出し元側の参照churnは別途修正済みだが、こちらは
  // 将来同種の回帰が起きても選択行リセットに波及させないための防御。
  const previousFilteredActionsRef = useRef<PaletteAction[]>([]);
  const filteredActions = useMemo(() => {
    const next = filterPaletteActions(actions, trimmedQuery);
    const previous = previousFilteredActionsRef.current;
    const isSameContent =
      previous.length === next.length &&
      previous.every((action, index) => action.id === next[index]?.id);
    if (isSameContent) {
      return previous;
    }
    previousFilteredActionsRef.current = next;
    return next;
  }, [actions, trimmedQuery]);

  const rows = useMemo<PaletteRow[]>(() => {
    const actionRows: PaletteRow[] = filteredActions.map((action) => ({
      kind: 'action',
      action,
    }));

    if (!hasQuery) {
      const recentRows: PaletteRow[] = recentTickets.map((ticket) => ({
        kind: 'recent',
        ticket,
      }));
      return [...actionRows, ...recentRows];
    }

    const ticketRows: PaletteRow[] = ticketResults.map((ticket) => ({
      kind: 'ticket',
      ticket,
    }));
    return [...actionRows, ...ticketRows];
  }, [filteredActions, ticketResults, hasQuery, recentTickets]);

  useFocusTrap({
    containerRef: panelRef,
    initialFocusRef: inputRef,
    onEscape: onClose,
  });

  useLayoutEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    setSelectedIndex(0);
  }, [rows]);

  useEffect(() => {
    if (!hasQuery) {
      setTicketResults([]);
      setIsLoading(false);
      setError(null);
      return;
    }

    let cancelled = false;
    setIsLoading(true);
    setError(null);

    const handle = window.setTimeout(() => {
      void searchTickets(trimmedQuery, SEARCH_LIMIT)
        .then((hits) => {
          if (cancelled) return;
          setTicketResults(hits);
          setIsLoading(false);
        })
        .catch((caught: unknown) => {
          if (cancelled) return;
          setError(
            caught instanceof Error ? caught : new Error('検索に失敗しました'),
          );
          setTicketResults([]);
          setIsLoading(false);
        });
    }, DEBOUNCE_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [hasQuery, trimmedQuery]);

  const handleActivateRow = useCallback(
    (row: PaletteRow) => {
      if (row.kind === 'action') {
        row.action.onSelect();
      } else {
        onSelect(row.ticket.id);
      }
      onClose();
    },
    [onClose, onSelect],
  );

  const handleInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' && rows.length > 0) {
      event.preventDefault();
      setSelectedIndex((current) => Math.min(current + 1, rows.length - 1));
      return;
    }

    if (event.key === 'ArrowUp' && rows.length > 0) {
      event.preventDefault();
      setSelectedIndex((current) => Math.max(current - 1, 0));
      return;
    }

    if (event.key === 'Enter' && rows.length > 0) {
      event.preventDefault();
      const row = rows[selectedIndex];
      if (row !== undefined) {
        handleActivateRow(row);
      }
    }
  };

  const showEmptyTicketsMessage =
    hasQuery &&
    !isLoading &&
    error === null &&
    ticketResults.length === 0 &&
    filteredActions.length === 0;

  const showRecentHeading = !hasQuery && recentTickets.length > 0;

  return (
    <div className="overlay search-overlay" onClick={onClose} role="presentation">
      <div
        ref={panelRef}
        className="search-palette"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="search-palette-title"
      >
        <h2 id="search-palette-title" className="sr-only">
          コマンドパレット
        </h2>
        <input
          ref={inputRef}
          type="search"
          className="search-palette-input"
          placeholder="チケット検索・ビュー切替・アクション"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={handleInputKeyDown}
          autoComplete="off"
          spellCheck={false}
          aria-label="検索クエリ"
        />

        {!hasQuery && (
          <p className="search-palette-hint">
            チケット検索のほか、ビュー切替やパネル起動ができます
          </p>
        )}

        {showRecentHeading && (
          <p className="search-palette-recent-heading">最近開いたチケット</p>
        )}

        {hasQuery && isLoading && (
          <p className="loading">チケットを検索中…</p>
        )}

        {hasQuery && !isLoading && error !== null && (
          <p className="error-message">{error.message}</p>
        )}

        {showEmptyTicketsMessage && (
          <p className="empty-message">該当するコマンドやチケットがありません</p>
        )}

        {rows.length > 0 && (
          <ul className="search-result-list" role="listbox" aria-label="検索結果">
            {rows.map((row, index) => {
              if (row.kind === 'action') {
                const { action } = row;
                return (
                  <li key={action.id}>
                    <button
                      type="button"
                      className={`search-result-item search-result-action${index === selectedIndex ? ' selected' : ''}`}
                      role="option"
                      aria-selected={index === selectedIndex}
                      onMouseEnter={() => setSelectedIndex(index)}
                      onClick={() => handleActivateRow(row)}
                    >
                      <span className="search-result-group">{action.group}</span>
                      <span className="search-result-title">{action.label}</span>
                      {action.detail !== undefined && (
                        <span className="search-result-detail">{action.detail}</span>
                      )}
                    </button>
                  </li>
                );
              }

              if (row.kind === 'recent') {
                const { ticket } = row;
                return (
                  <li key={`recent-${ticket.id}`}>
                    <button
                      type="button"
                      className={`search-result-item search-result-recent${index === selectedIndex ? ' selected' : ''}`}
                      role="option"
                      aria-selected={index === selectedIndex}
                      onMouseEnter={() => setSelectedIndex(index)}
                      onClick={() => handleActivateRow(row)}
                    >
                      <span className="search-result-project">{ticket.projectName}</span>
                      <span className="search-result-id">{ticket.id}</span>
                      <span className="search-result-title">{ticket.title}</span>
                    </button>
                  </li>
                );
              }

              const { ticket } = row;
              return (
                <li key={ticket.id}>
                  <button
                    type="button"
                    className={`search-result-item search-result-ticket${index === selectedIndex ? ' selected' : ''}`}
                    role="option"
                    aria-selected={index === selectedIndex}
                    onMouseEnter={() => setSelectedIndex(index)}
                    onClick={() => handleActivateRow(row)}
                  >
                    <span className="search-result-project">{ticket.projectName}</span>
                    <span className="search-result-id">{ticket.id}</span>
                    <span className="search-result-title">{ticket.title}</span>
                    <span className="search-result-priority">P{ticket.priority}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
