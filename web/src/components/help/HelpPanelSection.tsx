// bdboard-sso1.28: HelpPanel.tsx の1セクション分の <details> 表示を移動した
// だけの表示専用コンポーネント (move-only)。開閉 state・ref 登録・絞り込み
// 判定は親 (HelpPanel) に残し、値とハンドラを props で受け取る。JSX・
// className・aria属性・文言・DOM 構造・キーボード操作 (summary tabIndex)
// は移動前から変えていない。
import type { HelpSection } from '../../helpContent';
import { highlightMatches } from './helpSearch';

export interface HelpPanelSectionProps {
  section: HelpSection;
  index: number;
  isOpen: boolean;
  isFiltering: boolean;
  normalizedQuery: string;
  onToggle: (isOpen: boolean) => void;
  setRef: (element: HTMLDetailsElement | null) => void;
}

export function HelpPanelSection({
  section,
  index,
  isOpen,
  isFiltering,
  normalizedQuery,
  onToggle,
  setRef,
}: HelpPanelSectionProps) {
  const headingId = `help-section-${section.id}`;

  return (
    <details
      ref={setRef}
      className="help-panel-section"
      open={isOpen}
      aria-labelledby={headingId}
      onToggle={(event) => onToggle(event.currentTarget.open)}
    >
      <summary className="help-panel-section-summary" tabIndex={0}>
        <span className="help-panel-section-number" aria-hidden="true">
          {String(index + 1).padStart(2, '0')}
        </span>
        <h3 id={headingId}>
          {isFiltering
            ? highlightMatches(section.title, normalizedQuery)
            : section.title}
        </h3>
      </summary>
      <div className="help-panel-section-content">
        <p>
          {isFiltering
            ? highlightMatches(section.description, normalizedQuery)
            : section.description}
        </p>
        <ul>
          {section.steps.map((step) => (
            <li key={step}>
              {isFiltering ? highlightMatches(step, normalizedQuery) : step}
            </li>
          ))}
        </ul>
      </div>
    </details>
  );
}
