// bdboard-sso1.70: BoardFilterBar.tsx の state・派生値・ハンドラを束ねた関心別フック。
// フックの呼び出し順(useMatchMedia -> useState -> useRef)・依存関係・ref 共有は
// 移動前と同一(呼び出し元 BoardFilterBar はこのフック1つだけを呼び出すため、React
// から見た通算のフック呼び出し順序は変わらない)。挙動は一切変えていない。
import { useRef, useState } from 'react';
import { compareStrings } from '../../compare';
import { useMatchMedia } from '../../hooks/useMatchMedia';
import { MOBILE_LAYOUT_MEDIA_QUERY } from '../../mediaQueries';
import type { PriorityCeilingChoice } from '../../uiPersistedState';
import { countActiveFilters } from './boardFilterBarHelpers';

export interface UseBoardFilterBarParams {
  priorityCeiling: PriorityCeilingChoice;
  onPriorityCeilingChange: (choice: PriorityCeilingChoice) => void;
  issueTypes: string[];
  onIssueTypesChange: (types: string[]) => void;
  labels: string[];
  onLabelsChange: (labels: string[]) => void;
  availableLabels: string[] | undefined;
  filterText: string;
  onFilterTextChange: (text: string) => void;
}

export function useBoardFilterBar({
  priorityCeiling,
  onPriorityCeilingChange,
  issueTypes,
  onIssueTypesChange,
  labels,
  onLabelsChange,
  availableLabels,
  filterText,
  onFilterTextChange,
}: UseBoardFilterBarParams) {
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
  const labelOptions = [...new Set([...(availableLabels ?? []), ...labels])].sort(
    compareStrings,
  );
  // 盤面を知らないあいだは「無い」と言い切れない。undefined のときは 1 つも
  // missing にしない (= 何も主張しない) 側へ倒す。
  const boardLabelsKnown = availableLabels !== undefined;
  const availableLabelSet = new Set(availableLabels ?? []);
  const isMissingLabel = (label: string) =>
    boardLabelsKnown && !availableLabelSet.has(label);
  // 補足要素の有無とチップの印は同じ集合 (labelOptions) から導く。labels 側を
  // 走査すると、将来 labelOptions の供給元が増えたときに「印は付くが説明要素が
  // 無い」= aria-describedby が宙ぶらりんになる組み合わせが作れてしまう。
  const hasMissingLabel = labelOptions.some(isMissingLabel);

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

  const toggleExpanded = () => setExpanded((value) => !value);

  const handleClearAndRefocusToggle = () => {
    handleClearFilter();
    // 押した直後にこのボタン自身が unmount されるのでフォーカスが body へ
    // 落ちる。トグル本体へ戻して文脈を失わせない。
    toggleRef.current?.focus();
  };

  return {
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
  };
}
