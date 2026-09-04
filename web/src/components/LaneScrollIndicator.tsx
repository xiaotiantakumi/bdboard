import { useCallback, useEffect, useState, type RefObject } from 'react';
import { LANE_LABELS, type Lane } from '../api';
import { navCurrentProps } from './toggleGroupA11y';
import { selectMostVisibleLane } from './laneScrollTracking';

export interface LaneIndicatorItem {
  lane: Lane;
  countLabel: string;
}

interface LaneScrollIndicatorProps {
  lanes: readonly Lane[];
  items: readonly LaneIndicatorItem[];
  scrollContainerRef: RefObject<HTMLElement | null>;
  enabled: boolean;
}

export function LaneScrollIndicator({
  lanes,
  items,
  scrollContainerRef,
  enabled,
}: LaneScrollIndicatorProps) {
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
      target?.scrollIntoView({ behavior: 'smooth', inline: 'start', block: 'nearest' });
      setActiveLane(lane);
    },
    [scrollContainerRef],
  );

  if (!enabled || items.length === 0) {
    return null;
  }

  return (
    <nav className="lane-indicator-strip" aria-label="レーン切り替え">
      <ul className="lane-indicator-list">
        {items.map((item) => {
          const isCurrent = item.lane === activeLane;
          const ariaLabel = item.countLabel.startsWith('WIP超過:')
            ? `${LANE_LABELS[item.lane]} (${item.countLabel})`
            : `${LANE_LABELS[item.lane]} (${item.countLabel}件)`;
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
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
