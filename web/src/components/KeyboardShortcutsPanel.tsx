import { useRef } from 'react';
import {
  groupKeyboardShortcuts,
  KEYBOARD_SHORTCUTS,
} from '../keyboardShortcuts';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { useHistoryBackClose } from '../hooks/useHistoryBackClose';

interface KeyboardShortcutsPanelProps {
  onClose: () => void;
}

export function KeyboardShortcutsPanel({ onClose }: KeyboardShortcutsPanelProps) {
  const panelRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  const { requestClose } = useHistoryBackClose({
    panelId: 'shortcuts-help',
    onClose,
  });

  useFocusTrap({
    containerRef: panelRef,
    initialFocusRef: closeButtonRef,
    onEscape: requestClose,
  });

  const grouped = groupKeyboardShortcuts(KEYBOARD_SHORTCUTS);

  return (
    <div
      className="overlay shortcuts-help-overlay"
      onClick={requestClose}
      role="presentation"
    >
      <aside
        ref={panelRef}
        className="shortcuts-help-panel"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="shortcuts-help-title"
        tabIndex={-1}
      >
        <div className="detail-header">
          <h2 id="shortcuts-help-title" className="detail-title">
            キーボードショートカット
          </h2>
          <button
            ref={closeButtonRef}
            type="button"
            className="btn detail-close"
            onClick={requestClose}
          >
            閉じる
          </button>
        </div>

        <div className="shortcuts-help-body">
          {Array.from(grouped.entries()).map(([category, entries]) => (
            <section key={category} className="shortcuts-help-section">
              <h3 className="shortcuts-help-category">{category}</h3>
              <ul className="shortcuts-help-list">
                {entries.map((entry) => (
                  <li key={entry.id} className="shortcuts-help-row">
                    <span className="shortcuts-help-keys">{entry.keys}</span>
                    <span className="shortcuts-help-description">
                      {entry.description}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </aside>
    </div>
  );
}
