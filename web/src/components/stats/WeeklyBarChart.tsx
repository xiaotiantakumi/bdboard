// bdboard-sso1.20: ThroughputStats.tsx から自己完結した表示専用コンポーネントを
// 移動しただけのファイル。挙動は一切変えていない。
import type { WeeklyBarChartProps } from './types';
import { ChartBlockHeader } from './ChartBlockHeader';
import { formatWeekLabel } from '../throughputStatsFormatting';

export function WeeklyBarChart({ weeklyCloses, chartLabel }: WeeklyBarChartProps) {
  const maxCount = Math.max(1, ...weeklyCloses.map((entry) => entry.count));
  const barWidth = 100 / Math.max(weeklyCloses.length, 1);
  const chartHeight = 48;

  return (
    <div className="throughput-chart-block">
      <ChartBlockHeader
        heading="週次クローズ数"
        level={5}
      />
      <ul className="throughput-week-list">
        {weeklyCloses.map((entry) => (
          <li key={entry.weekStart} className="throughput-week-item">
            <span className="throughput-week-label">
              {formatWeekLabel(entry.weekStart)}
            </span>
            <span className="throughput-week-count">{entry.count}件</span>
          </li>
        ))}
      </ul>
      <svg
        className="throughput-week-chart"
        viewBox={`0 0 100 ${chartHeight}`}
        width="100%"
        role="img"
        aria-label={chartLabel}
      >
        {weeklyCloses.map((entry, index) => {
          const barHeight = (entry.count / maxCount) * (chartHeight - 8);
          const x = index * barWidth + barWidth * 0.15;
          const width = barWidth * 0.7;
          const y = chartHeight - barHeight;
          const label = `${formatWeekLabel(entry.weekStart)}: ${entry.count}件`;

          return (
            <g key={entry.weekStart}>
              <rect
                x={x}
                y={y}
                width={width}
                height={barHeight}
                rx={1.5}
                className="throughput-week-bar"
                aria-hidden="true"
              >
                <title>{label}</title>
              </rect>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

