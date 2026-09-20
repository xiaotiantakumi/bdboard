// bdboard-sso1.28: HelpPanel.tsx の絞り込み・開閉 state とハンドラをカスタム
// フックへ抽出しただけ (move-only)。フックの呼び出し順・依存配列・処理内容は
// 移動前から変えていない。共有 state (Set の中身の意味など) も変えていない。
// HelpPanel 側に残る panelRef/closeButtonRef (useFocusTrap 用) には依存しない
// ため、引数を取らない。
import {
  type ChangeEvent,
  type CompositionEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { HELP_SECTIONS } from '../../helpContent';
import { normalizeForSearch, sectionMatchesQuery } from './helpSearch';

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

  const filteredSections = useMemo(
    () =>
      HELP_SECTIONS.filter((section) =>
        sectionMatchesQuery(section, normalizedAppliedQuery),
      ),
    [normalizedAppliedQuery],
  );

  const isSectionOpen = useCallback(
    (sectionId: string) => {
      if (isFiltering) {
        return !closedWhileFilteringIds.has(sectionId);
      }
      return openSectionIds.has(sectionId);
    },
    [closedWhileFilteringIds, isFiltering, openSectionIds],
  );

  const allFilteredOpen =
    filteredSections.length > 0 &&
    filteredSections.every((section) => isSectionOpen(section.id));

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

  const setSectionRef = useCallback(
    (sectionId: string, element: HTMLDetailsElement | null) => {
      if (element === null) {
        sectionRefs.current.delete(sectionId);
        return;
      }
      sectionRefs.current.set(sectionId, element);
    },
    [],
  );

  const handleSectionToggle = useCallback(
    (sectionId: string, isOpen: boolean) => {
      if (isFiltering) {
        setClosedWhileFilteringIds((previous) => {
          if (isOpen) {
            if (!previous.has(sectionId)) {
              return previous;
            }
            const next = new Set(previous);
            next.delete(sectionId);
            return next;
          }
          if (previous.has(sectionId)) {
            return previous;
          }
          const next = new Set(previous);
          next.add(sectionId);
          return next;
        });
        return;
      }

      setOpenSectionIds((previous) => {
        if (isOpen) {
          if (previous.has(sectionId)) {
            return previous;
          }
          const next = new Set(previous);
          next.add(sectionId);
          return next;
        }
        if (!previous.has(sectionId)) {
          return previous;
        }
        const next = new Set(previous);
        next.delete(sectionId);
        return next;
      });
    },
    [isFiltering],
  );

  const handleToggleAll = useCallback(() => {
    if (isFiltering) {
      setClosedWhileFilteringIds((previous) => {
        const next = new Set(previous);
        if (allFilteredOpen) {
          for (const section of filteredSections) {
            next.add(section.id);
          }
        } else {
          for (const section of filteredSections) {
            next.delete(section.id);
          }
        }
        if (next.size === previous.size) {
          let unchanged = true;
          for (const id of next) {
            if (!previous.has(id)) {
              unchanged = false;
              break;
            }
          }
          if (unchanged) {
            return previous;
          }
        }
        return next;
      });
      return;
    }

    setOpenSectionIds((previous) => {
      const next = new Set(previous);
      if (allFilteredOpen) {
        for (const section of filteredSections) {
          next.delete(section.id);
        }
      } else {
        for (const section of filteredSections) {
          next.add(section.id);
        }
      }
      if (next.size === previous.size) {
        let unchanged = true;
        for (const id of next) {
          if (!previous.has(id)) {
            unchanged = false;
            break;
          }
        }
        if (unchanged) {
          return previous;
        }
      }
      return next;
    });
  }, [allFilteredOpen, filteredSections, isFiltering]);

  const handleJumpToSection = useCallback(
    (sectionId: string) => {
      if (isFiltering) {
        setClosedWhileFilteringIds((previous) => {
          if (!previous.has(sectionId)) {
            return previous;
          }
          const next = new Set(previous);
          next.delete(sectionId);
          return next;
        });
      } else {
        setOpenSectionIds((previous) => {
          if (previous.has(sectionId)) {
            return previous;
          }
          const next = new Set(previous);
          next.add(sectionId);
          return next;
        });
      }

      // jsdom has no Element.prototype.scrollIntoView — mirror HelpPanel.test.tsx stub if
      // adding palette→help→TOC navigation tests elsewhere (e.g. App.test.tsx).
      requestAnimationFrame(() => {
        const sectionElement = sectionRefs.current.get(sectionId);
        sectionElement?.scrollIntoView({ block: 'start' });
        sectionElement?.querySelector('summary')?.focus();
      });
    },
    [isFiltering],
  );

  const handleFilterBlur = useCallback(() => {
    isComposingRef.current = false;
  }, []);

  const handleFilterChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const value = event.target.value;
      setFilterQuery(value);
      // nativeEvent は Event 型だが、一部環境では compositionstart より先に input が来る
      const nativeEvent = event.nativeEvent as Event & { isComposing?: boolean };
      if (nativeEvent.isComposing === false) {
        isComposingRef.current = false;
      }
      if (!isComposingRef.current && nativeEvent.isComposing !== true) {
        setAppliedQuery(value);
      }
    },
    [],
  );

  const handleCompositionStart = useCallback(() => {
    isComposingRef.current = true;
  }, []);

  const handleCompositionEnd = useCallback(
    (event: CompositionEvent<HTMLInputElement>) => {
      isComposingRef.current = false;
      const value = event.currentTarget.value;
      setFilterQuery(value);
      setAppliedQuery(value);
    },
    [],
  );

  // useFocusTrap は <aside> にネイティブ keydown（バブル）を付ける。React の onKeyDown も
  // ルート委譲のバブルなので、input → aside ネイティブ → root React バブル の順になり
  // stopPropagation() では trap 側を止められない。onKeyDownCapture + preventDefault() で
  // useFocusTrap の defaultPrevented バイパスを先に効かせ、入力あり時だけパネル閉じを抑止する。
  const handleFilterKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key !== 'Escape') {
        return;
      }
      if (isComposingRef.current || event.nativeEvent.isComposing === true) {
        // 合成中 Escape は主要ブラウザでは key: "Process" で届かず到達不能だが、
        // 万一届いた場合は preventDefault してパネル閉じを抑止する。トレードオフ:
        // IME キャンセルが効かない代わりに「パネルが消えて文脈ごと失われる」を防ぐ。
        // IME キャンセルは選択削除で回避できるが、パネル消失は 1 打鍵で不可逆。
        event.preventDefault();
        return;
      }
      if (filterQuery !== '') {
        event.preventDefault();
        setFilterQuery('');
        setAppliedQuery('');
      }
    },
    [filterQuery],
  );

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
