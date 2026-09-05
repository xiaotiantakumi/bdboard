import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { LANE_LABELS, type Lane } from '../api';
import { useLaneStripHeightVar } from '../hooks/useLaneStripHeightVar';
import { navCurrentProps } from './toggleGroupA11y';
import { selectMostVisibleLane } from './laneScrollTracking';

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export interface LaneIndicatorItem {
  lane: Lane;
  countLabel: string;
}

interface LaneScrollIndicatorProps {
  lanes: readonly Lane[];
  items: readonly LaneIndicatorItem[];
  scrollContainerRef: RefObject<HTMLElement | null>;
  enabled: boolean;
  /**
   * bdboard-6y5b: モバイルでは .lane-header (レーン名・件数・折りたたみトグル) を
   * 丸ごと描画しない (index.css の `@media (max-width: 700px) { .lane-header
   * { display: none; } }` 参照)。折りたたみトグルはレーンヘッダーにしか無い
   * 唯一の操作なので、到達性を落とさないようここへ移す。両方渡されたときだけ
   * トグルボタンを描画する (呼び出し元がまだ未対応なら何も増やさない)。
   */
  collapsedLanes?: ReadonlySet<Lane>;
  onToggleCollapse?: (lane: Lane) => void;
}

export function LaneScrollIndicator({
  lanes,
  items,
  scrollContainerRef,
  enabled,
  collapsedLanes,
  onToggleCollapse,
}: LaneScrollIndicatorProps) {
  const stripRef = useRef<HTMLElement>(null);
  const stripVisible = enabled && items.length > 0;
  useLaneStripHeightVar(stripRef, stripVisible);

  const [activeLane, setActiveLane] = useState<Lane | null>(() => lanes[0] ?? null);

  useEffect(() => {
    setActiveLane((current) => {
      if (current !== null && lanes.includes(current)) {
        return current;
      }
      return lanes[0] ?? null;
    });
  }, [lanes]);

  useEffect(() => {
    if (!enabled) {
      return;
    }
    const root = scrollContainerRef.current;
    if (root === null) {
      return;
    }

    const laneElements = lanes
      .map((lane) => root.querySelector<HTMLElement>(`[data-lane="${lane}"]`))
      .filter((element): element is HTMLElement => element !== null);

    if (laneElements.length === 0) {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        const next = selectMostVisibleLane(entries, lanes);
        if (next !== null) {
          setActiveLane(next);
        }
      },
      {
        root,
        threshold: [0, 0.25, 0.5, 0.75, 1],
      },
    );

    for (const element of laneElements) {
      observer.observe(element);
    }

    return () => observer.disconnect();
  }, [enabled, lanes, scrollContainerRef]);

  const scrollToLane = useCallback(
    (lane: Lane) => {
      const root = scrollContainerRef.current;
      if (root === null) {
        return;
      }
      const target = root.querySelector<HTMLElement>(`[data-lane="${lane}"]`);
      // scrollIntoView の behavior は JS 側で明示すると CSS scroll-behavior より優先される。
      const scrollBehavior = prefersReducedMotion() ? 'auto' : 'smooth';
      target?.scrollIntoView({ behavior: scrollBehavior, inline: 'start', block: 'nearest' });
      setActiveLane(lane);
    },
    [scrollContainerRef],
  );

  if (!stripVisible) {
    return null;
  }

  return (
    <nav ref={stripRef} className="lane-indicator-strip" aria-label="レーン切り替え">
      <ul className="lane-indicator-list">
        {items.map((item) => {
          const isCurrent = item.lane === activeLane;
          const ariaLabel = item.countLabel.startsWith('WIP超過:')
            ? `${LANE_LABELS[item.lane]} (${item.countLabel})`
            : `${LANE_LABELS[item.lane]} (${item.countLabel}件)`;
          const isCollapsed = collapsedLanes?.has(item.lane) ?? false;
          return (
            <li key={item.lane} className="lane-indicator-item-wrap">
              <button
                type="button"
                className={`lane-indicator-item${isCurrent ? ' lane-indicator-item-current' : ''}`}
                {...navCurrentProps(isCurrent)}
                aria-label={ariaLabel}
                onClick={() => scrollToLane(item.lane)}
              >
                <span className="lane-indicator-label">{LANE_LABELS[item.lane]}</span>
                <span className="lane-indicator-count">{item.countLabel}</span>
              </button>
              {onToggleCollapse !== undefined && (
                <button
                  type="button"
                  className="lane-indicator-collapse-toggle"
                  aria-expanded={!isCollapsed}
                  aria-label={`${LANE_LABELS[item.lane]}レーンを${isCollapsed ? '展開' : '折りたたむ'}`}
                  onClick={() => onToggleCollapse(item.lane)}
                >
                  <span aria-hidden="true">{isCollapsed ? '▶' : '▼'}</span>
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
