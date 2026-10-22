import { useRef } from 'react';
import { LANE_LABELS, type Lane } from '../api';
import { useLaneStripHeightVar } from '../hooks/useLaneStripHeightVar';
import { togglePressedProps } from './toggleGroupA11y';

export interface LaneIndicatorItem {
  lane: Lane;
  countLabel: string;
}

interface LanePickerProps {
  items: readonly LaneIndicatorItem[];
  selectedLane: Lane;
  onSelect: (lane: Lane) => void;
  enabled: boolean;
}

/**
 * bdboard-pj9e: スマホ幅ではレーンを 1 つだけ表示し、この帯で表示するレーンを選ぶ。
 * クラス名 (.lane-indicator-strip ほか) は旧レーンスクロールインジケータのものを
 * 引き継ぐ — sticky 配置・--lane-strip-height・e2e の計測がこの名前に依存している。
 */
export function LanePicker({ items, selectedLane, onSelect, enabled }: LanePickerProps) {
  const stripRef = useRef<HTMLElement>(null);
  const stripVisible = enabled && items.length > 0;
  useLaneStripHeightVar(stripRef, stripVisible);

  if (!stripVisible) {
    return null;
  }

  return (
    <nav ref={stripRef} className="lane-indicator-strip" aria-label="レーン切り替え">
      <ul
        className="lane-indicator-list"
        style={{ gridTemplateColumns: `repeat(${items.length}, minmax(0, 1fr))` }}
      >
        {items.map((item) => {
          const isCurrent = item.lane === selectedLane;
          const ariaLabel = item.countLabel.startsWith('WIP超過:')
            ? `${LANE_LABELS[item.lane]} (${item.countLabel})`
            : `${LANE_LABELS[item.lane]} (${item.countLabel}件)`;
          return (
            <li key={item.lane} className="lane-indicator-item-wrap">
              <button
                type="button"
                className={`lane-indicator-item${isCurrent ? ' lane-indicator-item-current' : ''}`}
                {...togglePressedProps(isCurrent)}
                aria-label={ariaLabel}
                onClick={() => onSelect(item.lane)}
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
