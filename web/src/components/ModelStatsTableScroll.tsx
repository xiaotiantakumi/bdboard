import type { ReactNode } from 'react';
import { useScrollHints } from '../hooks/useScrollHints';

interface ModelStatsTableScrollProps {
  ariaLabel: string;
  children: ReactNode;
}

export function ModelStatsTableScroll({ ariaLabel, children }: ModelStatsTableScrollProps) {
  const { ref, canScrollStart, canScrollEnd } = useScrollHints<HTMLDivElement>();

  const scrollerClassName = [
    'model-stats-table-scroller',
    canScrollStart ? 'can-scroll-start' : '',
    canScrollEnd ? 'can-scroll-end' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={scrollerClassName}>
      <div
        className="model-stats-table-scroll"
        role="region"
        aria-label={ariaLabel}
        tabIndex={0}
        ref={ref}
      >
        {children}
      </div>
    </div>
  );
}
