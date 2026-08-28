import { useRef } from 'react';
import { HELP_SECTIONS } from '../helpContent';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { useHistoryBackClose } from '../hooks/useHistoryBackClose';

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

          <div className="help-panel-grid">
            {HELP_SECTIONS.map((section, index) => {
              const headingId = `help-section-${section.id}`;
              return (
                <section
                  key={section.id}
                  className="help-panel-section"
                  aria-labelledby={headingId}
                >
                  <span className="help-panel-section-number" aria-hidden="true">
                    {String(index + 1).padStart(2, '0')}
                  </span>
                  <h3 id={headingId}>{section.title}</h3>
                  <p>{section.description}</p>
                  <ul>
                    {section.steps.map((step) => (
                      <li key={step}>{step}</li>
                    ))}
                  </ul>
                </section>
              );
            })}
          </div>
        </div>
      </aside>
    </div>
  );
}
