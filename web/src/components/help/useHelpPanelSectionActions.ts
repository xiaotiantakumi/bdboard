// bdboard-sso1.67: useHelpPanelFilter.ts から、セクション DOM ref の登録と
// 開閉操作 (単体トグル/全開閉/TOC からのジャンプ) のハンドラを move-only で
// 切り出したフック。useCallback の依存配列は移動前から変えていない。各ハンドラの
// setState 更新関数の中身は、分割前に書かれていた if/else の Set 操作を
// ../help/helpPanelSectionSets.ts の純ヘルパー (openSection/closeSection/
// addAllToSet/removeAllFromSet) の呼び出しに置き換えている
// (呼び分けの対応は各ハンドラのコメントを参照。ロジックの等価性は
// helpPanelSectionSets.test.ts と既存の HelpPanel.test.tsx で固定)。
import { useCallback } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import type { HelpSection } from '../../helpContent';
import {
  addAllToSet,
  closeSection,
  openSection,
  removeAllFromSet,
} from './helpPanelSectionSets';

export interface UseHelpPanelSectionActionsParams {
  readonly sectionRefs: MutableRefObject<Map<string, HTMLDetailsElement>>;
  readonly isFiltering: boolean;
  readonly filteredSections: readonly HelpSection[];
  readonly allFilteredOpen: boolean;
  readonly setOpenSectionIds: Dispatch<SetStateAction<ReadonlySet<string>>>;
  readonly setClosedWhileFilteringIds: Dispatch<
    SetStateAction<ReadonlySet<string>>
  >;
}

export function useHelpPanelSectionActions({
  sectionRefs,
  isFiltering,
  filteredSections,
  allFilteredOpen,
  setOpenSectionIds,
  setClosedWhileFilteringIds,
}: UseHelpPanelSectionActionsParams) {
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
        // 絞り込み中は「閉じている ID の集合」を保持する。開く=集合から除去、
        // 閉じる=集合へ追加。
        setClosedWhileFilteringIds((previous) =>
          isOpen
            ? closeSection(previous, sectionId)
            : openSection(previous, sectionId),
        );
        return;
      }

      // 非絞り込み中は「開いている ID の集合」を保持する。開く=集合へ追加、
      // 閉じる=集合から除去。
      setOpenSectionIds((previous) =>
        isOpen
          ? openSection(previous, sectionId)
          : closeSection(previous, sectionId),
      );
    },
    [isFiltering],
  );

  const handleToggleAll = useCallback(() => {
    if (isFiltering) {
      // 全部開いている状態から押されたら、絞り込み結果の全 ID を
      // 「閉じている ID の集合」へ追加(=全部閉じる)。そうでなければ除去
      // (=全部開く)。
      setClosedWhileFilteringIds((previous) =>
        allFilteredOpen
          ? addAllToSet(previous, filteredSections)
          : removeAllFromSet(previous, filteredSections),
      );
      return;
    }

    // 全部開いている状態から押されたら、絞り込み結果の全 ID を
    // 「開いている ID の集合」から除去(=全部閉じる)。そうでなければ追加
    // (=全部開く)。
    setOpenSectionIds((previous) =>
      allFilteredOpen
        ? removeAllFromSet(previous, filteredSections)
        : addAllToSet(previous, filteredSections),
    );
  }, [allFilteredOpen, filteredSections, isFiltering]);

  const handleJumpToSection = useCallback(
    (sectionId: string) => {
      if (isFiltering) {
        setClosedWhileFilteringIds((previous) =>
          closeSection(previous, sectionId),
        );
      } else {
        setOpenSectionIds((previous) => openSection(previous, sectionId));
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

  return {
    setSectionRef,
    handleSectionToggle,
    handleToggleAll,
    handleJumpToSection,
  };
}
