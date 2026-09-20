import { useRef } from 'react';
import { HELP_SECTIONS } from '../helpContent';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { useHistoryBackClose } from '../hooks/useHistoryBackClose';
import { UpdateNotice } from './UpdateNotice';
import { HelpPanelControls } from './help/HelpPanelControls';
import { HelpPanelSection } from './help/HelpPanelSection';
import { HelpPanelToc } from './help/HelpPanelToc';
import { useHelpPanelFilter } from './help/useHelpPanelFilter';

export interface HelpPanelProps {
  onClose: () => void;
}

export function HelpPanel({ onClose }: HelpPanelProps) {
  const panelRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  const { requestClose } = useHistoryBackClose({
    panelId: 'help',
    onClose,
  });

  useFocusTrap({
    containerRef: panelRef,
    initialFocusRef: closeButtonRef,
    onEscape: requestClose,
  });

  const {
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
  } = useHelpPanelFilter();

  return (
    <div
      className="overlay help-panel-overlay"
      onClick={requestClose}
      role="presentation"
    >
      <aside
        ref={panelRef}
        className="help-panel"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="help-panel-title"
        aria-describedby="help-panel-intro"
        tabIndex={-1}
      >
        <div className="detail-header">
          <div>
            <p className="help-panel-eyebrow">BDBOARD GUIDE</p>
            <h2 id="help-panel-title" className="detail-title">
              ヘルプ
            </h2>
          </div>
          <div className="detail-header-actions">
            <UpdateNotice />
            <span className="help-panel-version">
              <span className="sr-only">bdboard バージョン </span>
              v{__BDBOARD_VERSION__}
            </span>
            <button
              ref={closeButtonRef}
              type="button"
              className="btn detail-close"
              onClick={requestClose}
            >
              閉じる
            </button>
          </div>
        </div>

        <div className="help-panel-body">
          <p id="help-panel-intro" className="help-panel-intro">
            bdboard は、複数プロジェクトの Beads チケットと作業セッションを1画面で追うためのローカルダッシュボードです。
            目的の機能名から、できることと基本操作を確認してください。
          </p>

          <HelpPanelControls
            filterQuery={filterQuery}
            onFilterChange={handleFilterChange}
            onFilterBlur={handleFilterBlur}
            onCompositionStart={handleCompositionStart}
            onCompositionEnd={handleCompositionEnd}
            onFilterKeyDown={handleFilterKeyDown}
            filterCountText={filterCountText}
            liveFilterCountText={liveFilterCountText}
            allFilteredOpen={allFilteredOpen}
            onToggleAll={handleToggleAll}
            filteredSectionsCount={filteredSections.length}
          />

          <HelpPanelToc
            sections={filteredSections}
            isFiltering={isFiltering}
            normalizedQuery={normalizedAppliedQuery}
            onJumpToSection={handleJumpToSection}
          />

          <div className="help-panel-grid">
            {filteredSections.map((section) => {
              const sectionIndex = HELP_SECTIONS.findIndex(
                (candidate) => candidate.id === section.id,
              );

              return (
                <HelpPanelSection
                  key={section.id}
                  section={section}
                  index={sectionIndex}
                  isOpen={isSectionOpen(section.id)}
                  isFiltering={isFiltering}
                  normalizedQuery={normalizedAppliedQuery}
                  onToggle={(open) => handleSectionToggle(section.id, open)}
                  setRef={(element) => setSectionRef(section.id, element)}
                />
              );
            })}
          </div>
        </div>
      </aside>
    </div>
  );
}
