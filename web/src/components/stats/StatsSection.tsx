// bdboard-sso1.20: ThroughputStats.tsx から自己完結した表示専用コンポーネントを
// 移動しただけのファイル。挙動は一切変えていない。
import type { ReactNode } from 'react';

export function StatsSection({
  heading,
  description,
  children,
}: {
  heading: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="throughput-stats-section" aria-label={heading}>
      <div className="throughput-stats-section-header">
        <h4 className="throughput-stats-section-heading">{heading}</h4>
        <p className="throughput-stats-section-description">{description}</p>
      </div>
      {children}
    </section>
  );
}
