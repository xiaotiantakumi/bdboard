// bdboard-sso1.28: HelpPanel.tsx の絞り込み・開閉 state とハンドラをカスタム
// フックへ抽出しただけ (move-only)。フックの呼び出し順・依存配列・処理内容は
// 移動前から変えていない。共有 state (Set の中身の意味など) も変えていない。
// HelpPanel 側に残る panelRef/closeButtonRef (useFocusTrap 用) には依存しない
// ため、引数を取らない。
//
// bdboard-sso1.67: 264 行あったこのファイルから、以下を move-only で切り出した。
// - ./helpPanelSectionSets.ts: セクション ID の Set を更新する副作用なしヘルパー
// - ./useHelpPanelFilteredSections.ts: 絞り込み後のセクション一覧 + 開閉判定
// - ./useHelpPanelSectionActions.ts: セクション ref 登録 + 開閉系ハンドラ
// - ./useHelpPanelFilterInputHandlers.ts: 絞り込み入力欄 (IME 込み) のハンドラ
// ここに残る useState/useRef の宣言順序・render 中の state 調整・
// useEffect (liveFilterCountText のデバウンス) は移動前と同じ位置関係を保って
// いる。3つの下位フック呼び出しは、分割前に各フックの中身が占めていた位置
// (filteredSections memo/isSectionOpen callback の直後 → liveFilterCountText の
// state/effect → setSectionRef 以降の開閉ハンドラ → 入力欄ハンドラ) の並びを
// そのまま保っており、フラット化した hook 呼び出し列は分割前と同じ順序になる。
import { useEffect, useRef, useState } from 'react';
import { HELP_SECTIONS } from '../../helpContent';
import { normalizeForSearch } from './helpSearch';
import { useHelpPanelFilteredSections } from './useHelpPanelFilteredSections';
import { useHelpPanelFilterInputHandlers } from './useHelpPanelFilterInputHandlers';
import { useHelpPanelSectionActions } from './useHelpPanelSectionActions';

const FILTER_COUNT_LIVE_DEBOUNCE_MS = 400;

export function useHelpPanelFilter() {
  const sectionRefs = useRef(new Map<string, HTMLDetailsElement>());
  const isComposingRef = useRef(false);

  const [filterQuery, setFilterQuery] = useState('');
  const [appliedQuery, setAppliedQuery] = useState('');
  const [openSectionIds, setOpenSectionIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [closedWhileFilteringIds, setClosedWhileFilteringIds] = useState<
    ReadonlySet<string>
  >(() => new Set());
  const [prevNormalizedAppliedQuery, setPrevNormalizedAppliedQuery] =
    useState('');

  const normalizedAppliedQuery = normalizeForSearch(appliedQuery.trim());
  const isFiltering = normalizedAppliedQuery.length > 0;

  if (normalizedAppliedQuery !== prevNormalizedAppliedQuery) {
    setPrevNormalizedAppliedQuery(normalizedAppliedQuery);
    if (isFiltering) {
      setClosedWhileFilteringIds(new Set());
    }
  }

  const { filteredSections, isSectionOpen, allFilteredOpen } =
    useHelpPanelFilteredSections({
      normalizedAppliedQuery,
      isFiltering,
      openSectionIds,
      closedWhileFilteringIds,
    });

  const filterCountText = `${HELP_SECTIONS.length}件中 ${filteredSections.length}件`;
  const [liveFilterCountText, setLiveFilterCountText] =
    useState(filterCountText);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      setLiveFilterCountText(filterCountText);
    }, FILTER_COUNT_LIVE_DEBOUNCE_MS);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [filterCountText]);

  const {
    setSectionRef,
    handleSectionToggle,
    handleToggleAll,
    handleJumpToSection,
  } = useHelpPanelSectionActions({
    sectionRefs,
    isFiltering,
    filteredSections,
    allFilteredOpen,
    setOpenSectionIds,
    setClosedWhileFilteringIds,
  });

  const {
    handleFilterBlur,
    handleFilterChange,
    handleCompositionStart,
    handleCompositionEnd,
    handleFilterKeyDown,
  } = useHelpPanelFilterInputHandlers({
    filterQuery,
    isComposingRef,
    setFilterQuery,
    setAppliedQuery,
  });

  return {
    filterQuery,
    filterCountText,
    liveFilterCountText,
    allFilteredOpen,
    filteredSections,
    isFiltering,
    normalizedAppliedQuery,
    isSectionOpen,
    setSectionRef,
    handleSectionToggle,
    handleToggleAll,
    handleJumpToSection,
    handleFilterBlur,
    handleFilterChange,
    handleCompositionStart,
    handleCompositionEnd,
    handleFilterKeyDown,
  };
}
