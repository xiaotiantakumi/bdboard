import {
  BOARD_ISSUE_TYPES,
  type PriorityCeilingChoice,
} from '../uiPersistedState';

export interface BoardFilterBarProps {
  priorityCeiling: PriorityCeilingChoice;
  onPriorityCeilingChange: (choice: PriorityCeilingChoice) => void;
  issueTypes: string[];
  onIssueTypesChange: (types: string[]) => void;
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

function isFilterActive(
  priorityCeiling: PriorityCeilingChoice,
  issueTypes: string[],
  filterText: string,
): boolean {
  return (
    priorityCeiling !== 'all' ||
    issueTypes.length > 0 ||
    filterText.trim() !== ''
  );
}

export function BoardFilterBar({
  priorityCeiling,
  onPriorityCeilingChange,
  issueTypes,
  onIssueTypesChange,
  filterText,
  onFilterTextChange,
}: BoardFilterBarProps) {
  const filterActive = isFilterActive(priorityCeiling, issueTypes, filterText);

  const handleIssueTypeToggle = (type: string) => {
    if (issueTypes.includes(type)) {
      onIssueTypesChange(issueTypes.filter((item) => item !== type));
    } else {
      onIssueTypesChange([...issueTypes, type]);
    }
  };

  const handleClearFilter = () => {
    onPriorityCeilingChange('all');
    onIssueTypesChange([]);
    onFilterTextChange('');
  };

  return (
    <div className="board-filter-bar" role="group" aria-label="ボード絞り込み">
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
  );
}
