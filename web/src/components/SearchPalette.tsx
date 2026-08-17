import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { searchTickets, type TicketSearchResultDto } from '../api';
import { useFocusTrap } from '../hooks/useFocusTrap';

const DEBOUNCE_MS = 200;
const SEARCH_LIMIT = 30;

interface SearchPaletteProps {
  onClose: () => void;
  onSelect: (ticketId: string) => void;
}

export function SearchPalette({ onClose, onSelect }: SearchPaletteProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<TicketSearchResultDto[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const trimmedQuery = query.trim();
  const hasQuery = trimmedQuery.length > 0;

  useFocusTrap({
    containerRef: panelRef,
    initialFocusRef: inputRef,
    onEscape: onClose,
  });

  useLayoutEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!hasQuery) {
      setResults([]);
      setIsLoading(false);
      setError(null);
      setSelectedIndex(0);
      return;
    }

    setIsLoading(true);
    setError(null);

    const handle = window.setTimeout(() => {
      void searchTickets(trimmedQuery, SEARCH_LIMIT)
        .then((hits) => {
          setResults(hits);
          setSelectedIndex(0);
          setIsLoading(false);
        })
        .catch((caught: unknown) => {
          setError(
            caught instanceof Error ? caught : new Error('検索に失敗しました'),
          );
          setResults([]);
          setIsLoading(false);
        });
    }, DEBOUNCE_MS);

    return () => {
      window.clearTimeout(handle);
    };
  }, [hasQuery, trimmedQuery]);

  const handleSelect = useCallback(
    (ticketId: string) => {
      onSelect(ticketId);
      onClose();
    },
    [onClose, onSelect],
  );

  const handleInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' && results.length > 0) {
      event.preventDefault();
      setSelectedIndex((current) => Math.min(current + 1, results.length - 1));
      return;
    }

    if (event.key === 'ArrowUp' && results.length > 0) {
      event.preventDefault();
      setSelectedIndex((current) => Math.max(current - 1, 0));
      return;
    }

    if (event.key === 'Enter' && results.length > 0) {
      event.preventDefault();
      const hit = results[selectedIndex];
      if (hit !== undefined) {
        handleSelect(hit.id);
      }
    }
  };

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
          チケット検索
        </h2>
        <input
          ref={inputRef}
          type="search"
          className="search-palette-input"
          placeholder="チケット ID・タイトル・説明を検索"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={handleInputKeyDown}
          autoComplete="off"
          spellCheck={false}
          aria-label="検索クエリ"
        />

        {!hasQuery && (
          <p className="search-palette-hint">ID、タイトル、説明で検索できます</p>
        )}

        {hasQuery && isLoading && <p className="loading">読み込み中…</p>}

        {hasQuery && !isLoading && error !== null && (
          <p className="error-message">
            {error.message}
          </p>
        )}

        {hasQuery && !isLoading && error === null && results.length === 0 && (
          <p className="empty-message">該当するチケットがありません</p>
        )}

        {hasQuery && !isLoading && error === null && results.length > 0 && (
          <ul className="search-result-list" role="listbox" aria-label="検索結果">
            {results.map((hit, index) => (
              <li key={hit.id}>
                <button
                  type="button"
                  className={`search-result-item${index === selectedIndex ? ' selected' : ''}`}
                  role="option"
                  aria-selected={index === selectedIndex}
                  onMouseEnter={() => setSelectedIndex(index)}
                  onClick={() => handleSelect(hit.id)}
                >
                  <span className="search-result-project">{hit.projectName}</span>
                  <span className="search-result-id">{hit.id}</span>
                  <span className="search-result-title">{hit.title}</span>
                  <span className="search-result-priority">P{hit.priority}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
