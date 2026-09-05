import { useRef, useState } from 'react';
import { compareStrings } from '../compare';
import { useMatchMedia } from '../hooks/useMatchMedia';
import { MOBILE_LAYOUT_MEDIA_QUERY } from '../mediaQueries';
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

/**
 * 盤面から消えたのに選択だけ残っているラベル (availableLabels に無いが labels にある)
 * のチップに付ける補足。id は sr-only な説明要素と aria-describedby の両側で共有する。
 * bdboard-we44 でチップ自体は描かれるようになったが、押された見た目が生きたチップと
 * 同じままだったので「0 件になっている理由」が読み取れなかった (bdboard-gxq5)。
 */
const MISSING_LABEL_HINT_ID = 'board-filter-missing-label-hint';
const MISSING_LABEL_HINT_TEXT = '現在の盤面には無いラベルです';

const PRIORITY_CEILING_OPTIONS: { value: PriorityCeilingChoice; label: string }[] = [
  { value: 'all', label: 'すべて' },
  { value: '0', label: 'P0' },
  { value: '1', label: 'P0-P1' },
  { value: '2', label: 'P0-P2' },
  { value: '3', label: 'P0-P3' },
  { value: '4', label: 'P0-P4' },
];

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
  // モバイル幅の展開状態は意図してローカルに保つ。App.tsx のビュー境界は `key={view}`
  // なので、ビュー切替時には再マウントされて折りたたみへ戻る。移動先の初回描画では
  // 縦の余白を最優先で取り戻すためであり、永続化やリフトアップはしない。
  const [expanded, setExpanded] = useState(false);
  const activeFilterCount = countActiveFilters(
    priorityCeiling,
    issueTypes,
    labels,
    filterText,
  );
  const filterActive = activeFilterCount > 0;
  const toggleRef = useRef<HTMLButtonElement>(null);
  const showFilterPanel = !isMobile || expanded;
  const labelOptions = [...new Set([...availableLabels, ...labels])].sort(compareStrings);
  const availableLabelSet = new Set(availableLabels);
  const hasMissingLabel = labels.some((label) => !availableLabelSet.has(label));

  const toggleAriaLabel =
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
        <div className="board-filter-toggle-row">
          <button
            type="button"
            ref={toggleRef}
            className="board-filter-toggle"
            aria-label={toggleAriaLabel}
            aria-expanded={expanded}
            aria-controls={expanded ? 'board-filter-panel' : undefined}
            onClick={() => setExpanded((value) => !value)}
          >
            <span className="board-filter-toggle-label">絞り込み</span>
            {filterActive && (
              <span className="board-filter-active-badge" aria-hidden="true">
                {activeFilterCount}
              </span>
            )}
          </button>
          {/* 折りたたみ時 (!expanded) かつ filterActive のときだけ表示する。
              展開時は board-filter-panel 側に既存の「フィルタ解除」があるため重複させない。
              常時表示にするとトグル行が常に2要素になり、折りたたみで稼いだ縦の節約を削るので
              条件付きのままにすること (bdboard-jch5)。

              アクセシブル名はパネル側の解除ボタンと同じ「フィルタ解除」にしてある。
              「絞り込みを解除」だとトグル本体の名前「絞り込み」の接頭辞拡張になり、
              e2e の getByRole('button', { name: /^絞り込み/ }) が2要素に当たって
              strict mode violation になる (board-filter-breakpoint /
              board-filter-mobile-reach / mobile-input-font-size /
              fixtures/mobile-chrome-helpers の assertBoardFilterBarCollapsed)。
              パネル側とは !expanded / expanded で排他なので同名でも衝突しない。
              可視ラベル「解除」は「フィルタ解除」に含まれるので WCAG 2.5.3 を満たす。 */}
          {!expanded && filterActive && (
            <button
              type="button"
              className="board-filter-toggle-clear"
              aria-label="フィルタ解除"
              onClick={() => {
                handleClearFilter();
                // 押した直後にこのボタン自身が unmount されるのでフォーカスが body へ
                // 落ちる。トグル本体へ戻して文脈を失わせない。
                toggleRef.current?.focus();
              }}
            >
              解除
            </button>
          )}
        </div>
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

          {labelOptions.length > 0 && (
            <div className="board-filter-group">
              <span className="header-label">ラベル</span>
              <div className="toggle-group board-filter-label-group">
                {labelOptions.map((label) => {
                  const selected = labels.includes(label);
                  // labelOptions は availableLabels と labels の和集合なので、
                  // availableLabels に無い = 選択が残っているだけの「盤面に無いラベル」。
                  // aria-pressed は「選択中」しか伝えないため、区別は modifier class
                  // (視覚) と aria-describedby (読み上げ) の両方で担う。
                  const missing = !availableLabelSet.has(label);
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
                      onClick={() => handleLabelToggle(label)}
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
