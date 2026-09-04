import type { ReactNode } from 'react';
import { useScrollHints } from '../hooks/useScrollHints';

interface ModelStatsTableScrollProps {
  ariaLabel: string;
  children: ReactNode;
}

export function ModelStatsTableScroll({ ariaLabel, children }: ModelStatsTableScrollProps) {
  const { ref, canScroll, canScrollStart, canScrollEnd } = useScrollHints<HTMLDivElement>();

  const scrollerClassName = [
    'model-stats-table-scroller',
    canScrollStart ? 'can-scroll-start' : '',
    canScrollEnd ? 'can-scroll-end' : '',
  ]
    .filter(Boolean)
    .join(' ');

  const scrollA11yProps = canScroll
    ? { role: 'region' as const, 'aria-label': ariaLabel, tabIndex: 0 }
    : {};

  return (
    <div className={scrollerClassName}>
      <div className="model-stats-table-scroll" ref={ref} {...scrollA11yProps}>
        {children}
      </div>
    </div>
  );
}
