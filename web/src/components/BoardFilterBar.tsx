import { useState } from 'react';
import { useMatchMedia } from '../hooks/useMatchMedia';
import {
  BOARD_ISSUE_TYPES,
  type PriorityCeilingChoice,
} from '../uiPersistedState';

export interface BoardFilterBarProps {
  priorityCeiling: PriorityCeilingChoice;
  onPriorityCeilingChange: (choice: PriorityCeilingChoice) => void;
  issueTypes: string[];
  onIssueTypesChange: (types: string[]) => void;
  labels: string[];
  onLabelsChange: (labels: string[]) => void;
  availableLabels: string[];
  filterText: string;
  onFilterTextChange: (text: string) => void;
}

const PRIORITY_CEILING_OPTIONS: { value: PriorityCeilingChoice; label: string }[] = [
  { value: 'all', label: 'すべて' },
  { value: '0', label: 'P0' },
  { value: '1', label: 'P0-P1' },
  { value: '2', label: 'P0-P2' },
  { value: '3', label: 'P0-P3' },
  { value: '4', label: 'P0-P4' },
];

/** Matches index.css @media (max-width: 700px). */
const MOBILE_LAYOUT_MEDIA_QUERY = '(max-width: 700px)';

export function isFilterActive(
  priorityCeiling: PriorityCeilingChoice,
  issueTypes: string[],
  labels: string[],
  filterText: string,
): boolean {
  return countActiveFilters(priorityCeiling, issueTypes, labels, filterText) > 0;
}

export function countActiveFilters(
  priorityCeiling: PriorityCeilingChoice,
  issueTypes: string[],
  labels: string[],
  filterText: string,
): number {
  let count = 0;
  if (priorityCeiling !== 'all') {
    count += 1;
  }
  count += issueTypes.length;
  count += labels.length;
  if (filterText.trim() !== '') {
    count += 1;
  }
  return count;
}

export function BoardFilterBar({
  priorityCeiling,
  onPriorityCeilingChange,
  issueTypes,
  onIssueTypesChange,
  labels,
  onLabelsChange,
  availableLabels,
  filterText,
  onFilterTextChange,
}: BoardFilterBarProps) {
  const isMobile = useMatchMedia(MOBILE_LAYOUT_MEDIA_QUERY);
  const [expanded, setExpanded] = useState(false);
  const activeFilterCount = countActiveFilters(
    priorityCeiling,
    issueTypes,
    labels,
    filterText,
  );
  const filterActive = activeFilterCount > 0;
  const showFilterPanel = !isMobile || expanded;

  const toggleLabel =
    activeFilterCount > 0
      ? `絞り込み (${activeFilterCount}件適用中)`
      : '絞り込み';

  const handleIssueTypeToggle = (type: string) => {
    if (issueTypes.includes(type)) {
      onIssueTypesChange(issueTypes.filter((item) => item !== type));
    } else {
      onIssueTypesChange([...issueTypes, type]);
    }
  };

  const handleLabelToggle = (label: string) => {
    if (labels.includes(label)) {
      onLabelsChange(labels.filter((item) => item !== label));
    } else {
      onLabelsChange([...labels, label]);
    }
  };

  const handleClearFilter = () => {
    onPriorityCeilingChange('all');
    onIssueTypesChange([]);
    onLabelsChange([]);
    onFilterTextChange('');
  };

  return (
    <div className="board-filter-bar" role="group" aria-label="ボード絞り込み">
      {isMobile && (
        <button
          type="button"
          className="board-filter-toggle"
          aria-expanded={expanded}
          aria-controls={expanded ? 'board-filter-panel' : undefined}
          onClick={() => setExpanded((value) => !value)}
        >
          <span className="board-filter-toggle-label">{toggleLabel}</span>
          {activeFilterCount > 0 && (
            <span className="board-filter-active-badge" aria-hidden="true">
              {activeFilterCount}
            </span>
          )}
        </button>
      )}

      {showFilterPanel && (
        <div id="board-filter-panel" className="board-filter-panel">
          <div className="board-filter-group">
            <label className="header-label" htmlFor="board-priority-ceiling">
              優先度上限
            </label>
            <select
              id="board-priority-ceiling"
              className="board-filter-select"
              value={priorityCeiling}
              onChange={(event) =>
                onPriorityCeilingChange(event.target.value as PriorityCeilingChoice)
              }
              aria-label="優先度上限"
            >
              {PRIORITY_CEILING_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>

          <div className="board-filter-group">
            <span className="header-label">種別</span>
            <div className="toggle-group board-filter-type-group">
              {BOARD_ISSUE_TYPES.map((type) => {
                const selected = issueTypes.includes(type);
                return (
                  <button
                    key={type}
                    type="button"
                    className={`toggle-btn${selected ? ' active' : ''}`}
                    aria-pressed={selected}
                    onClick={() => handleIssueTypeToggle(type)}
                  >
                    {type}
                  </button>
                );
              })}
            </div>
          </div>

          {availableLabels.length > 0 && (
            <div className="board-filter-group">
              <span className="header-label">ラベル</span>
              <div className="toggle-group board-filter-label-group">
                {availableLabels.map((label) => {
                  const selected = labels.includes(label);
                  return (
                    <button
                      key={label}
                      type="button"
                      className={`toggle-btn${selected ? ' active' : ''}`}
                      aria-pressed={selected}
                      onClick={() => handleLabelToggle(label)}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          <div className="board-filter-group board-filter-text-group">
            <input
              type="search"
              className="board-filter-input"
              value={filterText}
              onChange={(event) => onFilterTextChange(event.target.value)}
              placeholder="タイトル/IDで絞り込み"
              aria-label="チケットの絞り込み"
            />
          </div>

          {filterActive && (
            <button
              type="button"
              className="btn btn-small board-filter-clear"
              onClick={handleClearFilter}
            >
              フィルタ解除
            </button>
          )}
        </div>
      )}
    </div>
  );
}
