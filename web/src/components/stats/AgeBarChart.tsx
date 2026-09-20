// bdboard-sso1.20: ThroughputStats.tsx から自己完結した表示専用コンポーネントを
// 移動しただけのファイル。挙動は一切変えていない。
import type { AgeBarChartProps } from './types';
import { CHART_DESCRIPTIONS } from './constants';
import { ChartBlockHeader } from './ChartBlockHeader';
import { ageBucketEntries } from '../throughputStatsFormatting';

export function AgeBarChart({ distribution, chartLabel }: AgeBarChartProps) {
  const entries = ageBucketEntries(distribution);
  const maxCount = Math.max(1, ...entries.map((entry) => entry.count));
  const chartWidth = 100;

  return (
    <div className="throughput-chart-block">
      <ChartBlockHeader
        heading="未完了チケットの年齢分布"
        description={CHART_DESCRIPTIONS.openTicketAge}
        level={5}
      />
      <ul className="throughput-age-list">
        {entries.map((entry) => (
          <li key={entry.key} className="throughput-age-item">
            <span className="throughput-age-label">{entry.label}</span>
            <span className="throughput-age-count">{entry.count}件</span>
          </li>
        ))}
      </ul>
      <svg
        className="throughput-age-chart"
        viewBox={`0 0 ${chartWidth} ${entries.length * 16}`}
        width="100%"
        role="img"
        aria-label={chartLabel}
      >
        {entries.map((entry, index) => {
          const barWidth = (entry.count / maxCount) * (chartWidth - 24);
          const y = index * 16 + 3;
          const label = `${entry.label}: ${entry.count}件`;

          return (
            <g key={entry.key}>
              <rect
                x={24}
                y={y}
                width={barWidth}
                height={10}
                rx={2}
                className="throughput-age-bar"
                aria-hidden="true"
              >
                <title>{label}</title>
              </rect>
              <text
                x={0}
                y={y + 8}
                className="throughput-age-axis-label"
                aria-hidden="true"
              >
                {entry.label}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

