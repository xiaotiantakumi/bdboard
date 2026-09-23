// bdboard-sso1.70: BoardFilterBar.tsx のフィルタパネル本体(優先度上限/種別/ラベル/
// テキスト/フィルタ解除)を移動しただけの表示専用コンポーネント。state は
// 親(useBoardFilterBar)に残し、値とハンドラを props で受け取る。JSX・className・
// aria属性・文言・DOM構造は移動前から変えていない。
// onClearFilter は「フィルタ解除」ボタンの表示条件(filterActive)を兼ねる
// (undefined なら非表示)。移動前の `{filterActive && (<button onClick={handleClearFilter}>...` と
// 表示条件・クリック時の呼び出し先は同じで、条件判定を呼び出し側(親)に残したまま
// props を1つ減らしている。
import {
  BOARD_ISSUE_TYPES,
  type PriorityCeilingChoice,
} from '../../uiPersistedState';
import { PRIORITY_CEILING_OPTIONS, MISSING_LABEL_HINT_ID, MISSING_LABEL_HINT_TEXT } from './boardFilterBarHelpers';

export interface BoardFilterPanelProps {
  priorityCeiling: PriorityCeilingChoice;
  onPriorityCeilingChange: (choice: PriorityCeilingChoice) => void;
  issueTypes: string[];
  onIssueTypeToggle: (type: string) => void;
  labelOptions: string[];
  labels: string[];
  onLabelToggle: (label: string) => void;
  isMissingLabel: (label: string) => boolean;
  hasMissingLabel: boolean;
  filterText: string;
  onFilterTextChange: (text: string) => void;
  onClearFilter: (() => void) | undefined;
}

export function BoardFilterPanel({
  priorityCeiling,
  onPriorityCeilingChange,
  issueTypes,
  onIssueTypeToggle,
  labelOptions,
  labels,
  onLabelToggle,
  isMissingLabel,
  hasMissingLabel,
  filterText,
  onFilterTextChange,
  onClearFilter,
}: BoardFilterPanelProps) {
  return (
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
                onClick={() => onIssueTypeToggle(type)}
              >
                {type}
              </button>
            );
          })}
        </div>
      </div>

      {labelOptions.length > 0 && (
        <div className="board-filter-group">
          <span className="header-label">ラベル</span>
          <div className="toggle-group board-filter-label-group">
            {labelOptions.map((label) => {
              const selected = labels.includes(label);
              // labelOptions は availableLabels と labels の和集合なので、
              // 盤面が分かっていて availableLabels に無い = 選択が残っている
              // だけの「盤面に無いラベル」。aria-pressed は「選択中」しか
              // 伝えないため、区別は modifier class (視覚) と aria-describedby
              // (読み上げ) の両方で担う。
              const missing = isMissingLabel(label);
              return (
                <button
                  key={label}
                  type="button"
                  className={`toggle-btn${selected ? ' active' : ''}${
                    missing ? ' board-filter-label-missing' : ''
                  }`}
                  aria-pressed={selected}
                  // アクセシブル名は素のラベルのままにする。名前に接尾辞を足すと
                  // bdboard-we44 が入れた getByRole({ name: 'archived' }) 系や
                  // 並び順テストが芋づるで壊れ、WCAG 2.5.3 の検討も要る。
                  // 説明は aria-describedby に寄せる (title だけだとタッチで出ない)。
                  aria-describedby={missing ? MISSING_LABEL_HINT_ID : undefined}
                  title={missing ? MISSING_LABEL_HINT_TEXT : undefined}
                  onClick={() => onLabelToggle(label)}
                >
                  {label}
                </button>
              );
            })}
          </div>
          {hasMissingLabel && (
            <span id={MISSING_LABEL_HINT_ID} className="sr-only">
              {MISSING_LABEL_HINT_TEXT}
            </span>
          )}
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

      {onClearFilter !== undefined && (
        <button
          type="button"
          className="btn btn-small board-filter-clear"
          onClick={onClearFilter}
        >
          フィルタ解除
        </button>
      )}
    </div>
  );
}
