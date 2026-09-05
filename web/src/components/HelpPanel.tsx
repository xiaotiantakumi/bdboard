import { useCallback, useMemo, useRef, useState } from 'react';
import { HELP_SECTIONS } from '../helpContent';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { useHistoryBackClose } from '../hooks/useHistoryBackClose';
import { UpdateNotice } from './UpdateNotice';

export interface HelpPanelProps {
  onClose: () => void;
}

function sectionMatchesQuery(
  section: (typeof HELP_SECTIONS)[number],
  normalizedQuery: string,
): boolean {
  if (normalizedQuery.length === 0) {
    return true;
  }
  if (section.title.toLowerCase().includes(normalizedQuery)) {
    return true;
  }
  if (section.description.toLowerCase().includes(normalizedQuery)) {
    return true;
  }
  return section.steps.some((step) => step.toLowerCase().includes(normalizedQuery));
}

export function HelpPanel({ onClose }: HelpPanelProps) {
  const panelRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const sectionRefs = useRef(new Map<string, HTMLDetailsElement>());

  const [filterQuery, setFilterQuery] = useState('');
  const [openSectionIds, setOpenSectionIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );

  const { requestClose } = useHistoryBackClose({
    panelId: 'help',
    onClose,
  });

  useFocusTrap({
    containerRef: panelRef,
    initialFocusRef: closeButtonRef,
    onEscape: requestClose,
  });

  const normalizedFilterQuery = filterQuery.trim().toLowerCase();

  const filteredSections = useMemo(
    () =>
      HELP_SECTIONS.filter((section) =>
        sectionMatchesQuery(section, normalizedFilterQuery),
      ),
    [normalizedFilterQuery],
  );

  const allFilteredOpen =
    filteredSections.length > 0 &&
    filteredSections.every((section) => openSectionIds.has(section.id));

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
      setOpenSectionIds((previous) => {
        const next = new Set(previous);
        if (isOpen) {
          next.add(sectionId);
        } else {
          next.delete(sectionId);
        }
        return next;
      });
    },
    [],
  );

  const handleToggleAll = useCallback(() => {
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
      return next;
    });
  }, [allFilteredOpen, filteredSections]);

  const handleJumpToSection = useCallback((sectionId: string) => {
    setOpenSectionIds((previous) => {
      const next = new Set(previous);
      next.add(sectionId);
      return next;
    });

    requestAnimationFrame(() => {
      sectionRefs.current.get(sectionId)?.scrollIntoView({ block: 'start' });
    });
  }, []);

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

          <div className="help-panel-controls">
            <label className="help-panel-filter-label">
              <span className="help-panel-filter-label-text">絞り込み</span>
              <input
                type="search"
                className="help-panel-filter-input"
                value={filterQuery}
                onChange={(event) => setFilterQuery(event.target.value)}
                placeholder="キーワードでセクションを絞り込む"
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            <div className="help-panel-controls-meta">
              <p className="help-panel-filter-count" aria-live="polite">
                {HELP_SECTIONS.length}件中 {filteredSections.length}件
              </p>
              <button
                type="button"
                className="btn help-panel-toggle-all"
                onClick={handleToggleAll}
                disabled={filteredSections.length === 0}
              >
                {allFilteredOpen ? 'すべて閉じる' : 'すべて開く'}
              </button>
            </div>
          </div>

          {filteredSections.length > 0 ? (
            <nav className="help-panel-toc" aria-label="目次">
              {filteredSections.map((section) => (
                <button
                  key={section.id}
                  type="button"
                  className="help-panel-toc-item"
                  onClick={() => handleJumpToSection(section.id)}
                >
                  {section.title}
                </button>
              ))}
            </nav>
          ) : (
            <p className="help-panel-empty">該当するセクションがありません</p>
          )}

          <div className="help-panel-grid">
            {filteredSections.map((section) => {
              const sectionIndex = HELP_SECTIONS.findIndex(
                (candidate) => candidate.id === section.id,
              );
              const headingId = `help-section-${section.id}`;
              const isOpen = openSectionIds.has(section.id);

              return (
                <details
                  key={section.id}
                  ref={(element) => setSectionRef(section.id, element)}
                  className="help-panel-section"
                  open={isOpen}
                  onToggle={(event) => {
                    handleSectionToggle(section.id, event.currentTarget.open);
                  }}
                >
                  <summary className="help-panel-section-summary">
                    <span className="help-panel-section-number" aria-hidden="true">
                      {String(sectionIndex + 1).padStart(2, '0')}
                    </span>
                    <h3 id={headingId}>{section.title}</h3>
                  </summary>
                  <div className="help-panel-section-content">
                    <p>{section.description}</p>
                    <ul>
                      {section.steps.map((step) => (
                        <li key={step}>{step}</li>
                      ))}
                    </ul>
                  </div>
                </details>
              );
            })}
          </div>
        </div>
      </aside>
    </div>
  );
}
