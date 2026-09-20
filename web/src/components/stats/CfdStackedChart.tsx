// bdboard-sso1.20: ThroughputStats.tsx から自己完結した表示専用コンポーネントを
// 移動しただけのファイル。挙動は一切変えていない。
import type { CfdStackedChartProps } from './types';
import { CFD_STATUS_COLORS, CFD_STATUS_LABELS } from './constants';
import { collectCfdStatuses, dayTotal, formatCfdDateLabel, hasAnyCfdData } from './cfdHelpers';
import { ChartBlockHeader } from './ChartBlockHeader';

export function CfdStackedChart({ days, chartLabel }: CfdStackedChartProps) {
  if (days.length === 0 || !hasAnyCfdData(days)) {
    return (
      <div className="throughput-chart-block">
        <ChartBlockHeader
          heading="累積フロー図 (CFD)"
          level={5}
        />
        <p className="empty-message">CFDデータはまだありません</p>
      </div>
    );
  }

  const statuses = collectCfdStatuses(days);
  const maxTotal = Math.max(1, ...days.map((day) => dayTotal(day.counts)));
  const chartHeight = 56;
  const barWidth = 100 / Math.max(days.length, 1);
  const latestDay = days[days.length - 1];
  const visibleStatuses = statuses.filter((status) =>
    days.some((day) => (day.counts[status] ?? 0) > 0),
  );

  return (
    <div className="throughput-chart-block">
      <ChartBlockHeader
        heading="累積フロー図 (CFD)"
        level={5}
      />
      <ul className="throughput-cfd-list">
        {days.map((day) => (
          <li key={day.date} className="throughput-cfd-item">
            <span className="throughput-cfd-label">{formatCfdDateLabel(day.date)}</span>
            <span className="throughput-cfd-count">{dayTotal(day.counts)}件</span>
          </li>
        ))}
      </ul>
      {visibleStatuses.length > 0 && (
        <ul className="throughput-cfd-legend throughput-cfd-legend-above-chart" aria-label="ステータス凡例">
          {visibleStatuses.map((status) => {
            const latestCount = latestDay?.counts[status] ?? 0;
            return (
              <li key={status} className="throughput-cfd-legend-item">
                <span
                  className="throughput-cfd-legend-swatch"
                  style={{ background: CFD_STATUS_COLORS[status] ?? '#64748b' }}
                  aria-hidden="true"
                />
                <span>
                  {CFD_STATUS_LABELS[status] ?? status}
                  <span className="throughput-cfd-legend-count">
                    {' '}
                    (最新 {latestCount}件)
                  </span>
                </span>
              </li>
            );
          })}
        </ul>
      )}
      <svg
        className="throughput-cfd-chart"
        viewBox={`0 0 100 ${chartHeight}`}
        width="100%"
        role="img"
        aria-label={chartLabel}
      >
        {days.map((day, dayIndex) => {
          let cumulative = 0;
          const x = dayIndex * barWidth + barWidth * 0.12;
          const width = barWidth * 0.76;

          return statuses.flatMap((status) => {
            const count = day.counts[status] ?? 0;
            if (count <= 0) {
              return [];
            }

            const segmentHeight = (count / maxTotal) * (chartHeight - 8);
            const y = chartHeight - cumulative - segmentHeight;
            cumulative += (count / maxTotal) * (chartHeight - 8);
            const label = `${formatCfdDateLabel(day.date)} ${CFD_STATUS_LABELS[status] ?? status}: ${count}件`;

            return [
              <rect
                key={`${day.date}-${status}`}
                x={x}
                y={y}
                width={width}
                height={segmentHeight}
                className={`throughput-cfd-bar throughput-cfd-bar-${status.replace(/[^a-z0-9_-]/gi, '_')}`}
                style={{ fill: CFD_STATUS_COLORS[status] ?? '#64748b' }}
                aria-hidden="true"
              >
                <title>{label}</title>
              </rect>,
            ];
          });
        })}
      </svg>
    </div>
  );
}

