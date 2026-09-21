// bdboard-sso1.48: SearchPalette.tsx の検索結果 <ul> の描画を、挙動と DOM を
// 変えずにこの表示部品へ抽出しただけのファイル。rows が空のときは何も
// レンダリングしない(元の `{rows.length > 0 && (...)}` と同じ)。
import type { PaletteRow } from './types';

export interface SearchResultListProps {
  rows: PaletteRow[];
  selectedIndex: number;
  onHoverIndex: (index: number) => void;
  onActivate: (row: PaletteRow) => void;
}

export function SearchResultList({
  rows,
  selectedIndex,
  onHoverIndex,
  onActivate,
}: SearchResultListProps) {
  if (rows.length === 0) {
    return null;
  }

  return (
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
                onMouseEnter={() => onHoverIndex(index)}
                onClick={() => onActivate(row)}
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
                onMouseEnter={() => onHoverIndex(index)}
                onClick={() => onActivate(row)}
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
              onMouseEnter={() => onHoverIndex(index)}
              onClick={() => onActivate(row)}
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
  );
}
