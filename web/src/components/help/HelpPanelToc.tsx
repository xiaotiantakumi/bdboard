// bdboard-sso1.28: HelpPanel.tsx の目次 (TOC) ナビゲーションを移動しただけの
// 表示専用コンポーネント (move-only)。state・ジャンプ処理は
// useHelpPanelFilter フックに残し、値とハンドラを props で受け取る。JSX・className・文言・DOM 構造は
// 移動前から変えていない。
import type { HelpSection } from '../../helpContent';
import { highlightMatches } from './helpSearch';

export interface HelpPanelTocProps {
  sections: readonly HelpSection[];
  isFiltering: boolean;
  normalizedQuery: string;
  onJumpToSection: (sectionId: string) => void;
}

export function HelpPanelToc({
  sections,
  isFiltering,
  normalizedQuery,
  onJumpToSection,
}: HelpPanelTocProps) {
  return (
    <nav className="help-panel-toc" aria-label="目次">
      {sections.length > 0 ? (
        sections.map((section) => (
          <button
            key={section.id}
            type="button"
            className="help-panel-toc-item"
            onClick={() => onJumpToSection(section.id)}
          >
            {isFiltering
              ? highlightMatches(section.title, normalizedQuery)
              : section.title}
          </button>
        ))
      ) : (
        <p className="help-panel-empty">該当するセクションがありません</p>
      )}
    </nav>
  );
}
