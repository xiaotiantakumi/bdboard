// bdboard-sso1.67: useHelpPanelFilter.ts から、絞り込み後のセクション一覧と
// 「このセクションは開いているか」判定を move-only で切り出したフック。
// useMemo/useCallback の依存配列・本体は移動前から変えていない。
import { useCallback, useMemo } from 'react';
import { HELP_SECTIONS } from '../../helpContent';
import { sectionMatchesQuery } from './helpSearch';

export interface UseHelpPanelFilteredSectionsParams {
  readonly normalizedAppliedQuery: string;
  readonly isFiltering: boolean;
  readonly openSectionIds: ReadonlySet<string>;
  readonly closedWhileFilteringIds: ReadonlySet<string>;
}

export function useHelpPanelFilteredSections({
  normalizedAppliedQuery,
  isFiltering,
  openSectionIds,
  closedWhileFilteringIds,
}: UseHelpPanelFilteredSectionsParams) {
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

  return { filteredSections, isSectionOpen, allFilteredOpen };
}
