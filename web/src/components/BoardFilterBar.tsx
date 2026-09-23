import type { PriorityCeilingChoice } from '../uiPersistedState';
import { BoardFilterMobileToggle } from './board-filter/BoardFilterMobileToggle';
import { BoardFilterPanel } from './board-filter/BoardFilterPanel';
import { useBoardFilterBar } from './board-filter/useBoardFilterBar';

export { countActiveFilters, isFilterActive } from './board-filter/boardFilterBarHelpers';

export interface BoardFilterBarProps {
  priorityCeiling: PriorityCeilingChoice;
  onPriorityCeilingChange: (choice: PriorityCeilingChoice) => void;
  issueTypes: string[];
  onIssueTypesChange: (types: string[]) => void;
  labels: string[];
  onLabelsChange: (labels: string[]) => void;
  /**
   * 盤面に実在するラベル。**undefined は「盤面をまだ知らない」** (読み込み中 /
   * 取得失敗) を表し、空配列の「盤面は分かっていてラベルが無い」とは別物。
   * 混ぜると読み込み中に全チップが「盤面に無い」と嘘をつく (bdboard-gxq5)。
   */
  availableLabels: string[] | undefined;
  filterText: string;
  onFilterTextChange: (text: string) => void;
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
  const {
    isMobile,
    expanded,
    toggleExpanded,
    showFilterPanel,
    activeFilterCount,
    filterActive,
    toggleRef,
    toggleAriaLabel,
    labelOptions,
    isMissingLabel,
    hasMissingLabel,
    handleIssueTypeToggle,
    handleLabelToggle,
    handleClearFilter,
    handleClearAndRefocusToggle,
  } = useBoardFilterBar({
    priorityCeiling,
    onPriorityCeilingChange,
    issueTypes,
    onIssueTypesChange,
    labels,
    onLabelsChange,
    availableLabels,
    filterText,
    onFilterTextChange,
  });

  return (
    <div className="board-filter-bar" role="group" aria-label="ボード絞り込み">
      {isMobile && (
        <BoardFilterMobileToggle
          toggleRef={toggleRef}
          expanded={expanded}
          toggleAriaLabel={toggleAriaLabel}
          filterActive={filterActive}
          activeFilterCount={activeFilterCount}
          onToggleClick={toggleExpanded}
          onClearClick={handleClearAndRefocusToggle}
        />
      )}

      {showFilterPanel && (
        <BoardFilterPanel
          priorityCeiling={priorityCeiling}
          onPriorityCeilingChange={onPriorityCeilingChange}
          issueTypes={issueTypes}
          onIssueTypeToggle={handleIssueTypeToggle}
          labelOptions={labelOptions}
          labels={labels}
          onLabelToggle={handleLabelToggle}
          isMissingLabel={isMissingLabel}
          hasMissingLabel={hasMissingLabel}
          filterText={filterText}
          onFilterTextChange={onFilterTextChange}
          onClearFilter={filterActive ? handleClearFilter : undefined}
        />
      )}
    </div>
  );
}
