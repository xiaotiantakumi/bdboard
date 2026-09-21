import { useLayoutEffect, useRef, useState } from 'react';
import type { TicketSearchResultDto } from '../api';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { useHistoryBackClose } from '../hooks/useHistoryBackClose';
import type { PaletteAction } from '../paletteActions';
import type { RecentTicketEntry } from '../uiPersistedState';
import { SearchResultList } from './search-palette/SearchResultList';
import { EMPTY_RECENT_TICKETS } from './search-palette/types';
import { useDebouncedTicketSearch } from './search-palette/useDebouncedTicketSearch';
import { usePaletteActivation } from './search-palette/usePaletteActivation';
import { usePaletteRows } from './search-palette/usePaletteRows';

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

  const { requestClose, requestCloseThen } = useHistoryBackClose({
    panelId: 'search',
    onClose,
  });
  const [query, setQuery] = useState('');
  const [ticketResults, setTicketResults] = useState<TicketSearchResultDto[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const trimmedQuery = query.trim();
  const hasQuery = trimmedQuery.length > 0;

  useFocusTrap({
    containerRef: panelRef,
    initialFocusRef: inputRef,
    onEscape: requestClose,
  });

  useLayoutEffect(() => {
    inputRef.current?.focus();
  }, []);

  const { filteredActions, rows, selectedIndex, setSelectedIndex } = usePaletteRows({
    actions,
    trimmedQuery,
    hasQuery,
    ticketResults,
    recentTickets,
  });

  useDebouncedTicketSearch({
    hasQuery,
    trimmedQuery,
    setTicketResults,
    setIsLoading,
    setError,
  });

  const { handleActivateRow, handleInputKeyDown } = usePaletteActivation({
    rows,
    selectedIndex,
    setSelectedIndex,
    requestCloseThen,
    onSelect,
  });

  const showEmptyTicketsMessage =
    hasQuery &&
    !isLoading &&
    error === null &&
    ticketResults.length === 0 &&
    filteredActions.length === 0;

  const showRecentHeading = !hasQuery && recentTickets.length > 0;

  return (
    <div className="overlay search-overlay" onClick={requestClose} role="presentation">
      <div
        ref={panelRef}
        className="search-palette"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="search-palette-title"
      >
        <div className="search-palette-header">
          <h2 id="search-palette-title" className="sr-only">
            コマンドパレット
          </h2>
          {/* 44px タップ領域は @media (max-width:700px) の .btn.detail-close が与える。
              search-palette-close は将来のスタイリング/テスト用 hook で、対応 CSS は意図的に無い。 */}
          <button
            type="button"
            className="btn detail-close search-palette-close"
            onClick={requestClose}
          >
            閉じる
          </button>
        </div>
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

        {hasQuery && isLoading && <p className="loading">チケットを検索中…</p>}

        {hasQuery && !isLoading && error !== null && (
          <p className="error-message">{error.message}</p>
        )}

        {showEmptyTicketsMessage && (
          <p className="empty-message">該当するコマンドやチケットがありません</p>
        )}

        <SearchResultList
          rows={rows}
          selectedIndex={selectedIndex}
          onHoverIndex={setSelectedIndex}
          onActivate={handleActivateRow}
        />
      </div>
    </div>
  );
}
