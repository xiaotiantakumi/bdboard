import {
  type ChangeEvent,
  type CompositionEvent,
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { HELP_SECTIONS } from '../helpContent';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { useHistoryBackClose } from '../hooks/useHistoryBackClose';
import { UpdateNotice } from './UpdateNotice';

export interface HelpPanelProps {
  onClose: () => void;
}

const FILTER_COUNT_LIVE_DEBOUNCE_MS = 400;

// NFKC folds full-width alphanumerics (e.g. ＰＷＡ → PWA). Hiragana/katakana
// folding is out of scope — NFKC does not map カナ to かな.
function normalizeForSearch(text: string): string {
  return text.normalize('NFKC').toLowerCase();
}

function sectionMatchesQuery(
  section: (typeof HELP_SECTIONS)[number],
  normalizedQuery: string,
): boolean {
  if (normalizedQuery.length === 0) {
    return true;
  }
  if (normalizeForSearch(section.title).includes(normalizedQuery)) {
    return true;
  }
  if (normalizeForSearch(section.description).includes(normalizedQuery)) {
    return true;
  }
  return section.steps.some((step) =>
    normalizeForSearch(step).includes(normalizedQuery),
  );
}

function buildNormalizedIndexMap(text: string): {
  normalized: string;
  indexMap: number[];
} {
  const indexMap: number[] = [];
  let normalized = '';

  for (let index = 0; index < text.length; ) {
    const codePoint = text.codePointAt(index)!;
    const charLength = codePoint > 0xffff ? 2 : 1;
    const normalizedChar = String.fromCodePoint(codePoint)
      .normalize('NFKC')
      .toLowerCase();

    for (let charIndex = 0; charIndex < normalizedChar.length; charIndex += 1) {
      indexMap.push(index);
    }

    normalized += normalizedChar;
    index += charLength;
  }

  return { normalized, indexMap };
}

function highlightMatches(text: string, normalizedQuery: string): ReactNode {
  if (normalizedQuery.length === 0) {
    return text;
  }

  const { normalized, indexMap } = buildNormalizedIndexMap(text);
  const parts: ReactNode[] = [];
  let normalizedPosition = 0;
  let partKey = 0;

  while (normalizedPosition < normalized.length) {
    const matchIndex = normalized.indexOf(normalizedQuery, normalizedPosition);

    if (matchIndex === -1) {
      parts.push(text.slice(indexMap[normalizedPosition]));
      break;
    }

    if (matchIndex > normalizedPosition) {
      parts.push(
        text.slice(indexMap[normalizedPosition], indexMap[matchIndex]),
      );
    }

    const matchOrigStart = indexMap[matchIndex];
    const matchEndNormalized = matchIndex + normalizedQuery.length;
    const matchOrigEnd =
      matchEndNormalized < indexMap.length
        ? indexMap[matchEndNormalized]
        : text.length;

    parts.push(
      <mark key={partKey}>{text.slice(matchOrigStart, matchOrigEnd)}</mark>,
    );
    partKey += 1;
    normalizedPosition = matchEndNormalized;
  }

  if (parts.length === 1 && typeof parts[0] === 'string') {
    return parts[0];
  }

  return parts;
}

export function HelpPanel({ onClose }: HelpPanelProps) {
  const panelRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
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

  const { requestClose } = useHistoryBackClose({
    panelId: 'help',
    onClose,
  });

  useFocusTrap({
    containerRef: panelRef,
    initialFocusRef: closeButtonRef,
    onEscape: requestClose,
  });

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
          const next = new Set(previous);
          if (isOpen) {
            next.delete(sectionId);
          } else {
            next.add(sectionId);
          }
          return next;
        });
        return;
      }

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
      return next;
    });
  }, [allFilteredOpen, filteredSections, isFiltering]);

  const handleJumpToSection = useCallback(
    (sectionId: string) => {
      if (isFiltering) {
        setClosedWhileFilteringIds((previous) => {
          const next = new Set(previous);
          next.delete(sectionId);
          return next;
        });
      } else {
        setOpenSectionIds((previous) => {
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

  const handleFilterChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const value = event.target.value;
      setFilterQuery(value);
      // nativeEvent は Event 型だが、一部環境では compositionstart より先に input が来る
      const nativeEvent = event.nativeEvent as Event & { isComposing?: boolean };
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
      const nativeEvent = event.nativeEvent as Event & { isComposing?: boolean };
      if (isComposingRef.current || nativeEvent.isComposing === true) {
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
                onChange={handleFilterChange}
                onCompositionStart={handleCompositionStart}
                onCompositionEnd={handleCompositionEnd}
                onKeyDownCapture={handleFilterKeyDown}
                placeholder="キーワードでセクションを絞り込む"
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            <div className="help-panel-controls-meta">
              <p
                className="help-panel-filter-count"
                aria-hidden="true"
                data-testid="help-panel-filter-count"
              >
                {filterCountText}
              </p>
              <span
                className="sr-only"
                role="status"
                aria-live="polite"
                data-testid="help-panel-filter-count-live"
              >
                {liveFilterCountText}
              </span>
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

          <nav className="help-panel-toc" aria-label="目次">
            {filteredSections.length > 0 ? (
              filteredSections.map((section) => (
                <button
                  key={section.id}
                  type="button"
                  className="help-panel-toc-item"
                  onClick={() => handleJumpToSection(section.id)}
                >
                  {isFiltering
                    ? highlightMatches(section.title, normalizedAppliedQuery)
                    : section.title}
                </button>
              ))
            ) : (
              <p className="help-panel-empty">該当するセクションがありません</p>
            )}
          </nav>

          <div className="help-panel-grid">
            {filteredSections.map((section) => {
              const sectionIndex = HELP_SECTIONS.findIndex(
                (candidate) => candidate.id === section.id,
              );
              const headingId = `help-section-${section.id}`;
              const isOpen = isSectionOpen(section.id);

              return (
                <details
                  key={section.id}
                  ref={(element) => setSectionRef(section.id, element)}
                  className="help-panel-section"
                  open={isOpen}
                  aria-labelledby={headingId}
                  onToggle={(event) => {
                    handleSectionToggle(section.id, event.currentTarget.open);
                  }}
                >
                  <summary className="help-panel-section-summary" tabIndex={0}>
                    <span className="help-panel-section-number" aria-hidden="true">
                      {String(sectionIndex + 1).padStart(2, '0')}
                    </span>
                    <h3 id={headingId}>
                      {isFiltering
                        ? highlightMatches(section.title, normalizedAppliedQuery)
                        : section.title}
                    </h3>
                  </summary>
                  <div className="help-panel-section-content">
                    <p>
                      {isFiltering
                        ? highlightMatches(
                            section.description,
                            normalizedAppliedQuery,
                          )
                        : section.description}
                    </p>
                    <ul>
                      {section.steps.map((step) => (
                        <li key={step}>
                          {isFiltering
                            ? highlightMatches(step, normalizedAppliedQuery)
                            : step}
                        </li>
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
