// bdboard-sso1.20: ThroughputStats.tsx から自己完結した表示専用コンポーネントを
// 移動しただけのファイル。挙動は一切変えていない。
import type { ModelStatsDto } from '../../api';
import { CHART_DESCRIPTIONS } from './constants';
import { collectModelNames, hasAnyModelStatsData } from './statsDataHelpers';
import { ChartBlockHeader } from './ChartBlockHeader';
import { ModelStatsTableScroll } from '../ModelStatsTableScroll';
import { formatWeekLabel } from '../throughputStatsFormatting';

export function ModelStatsTables({ stats }: { stats: ModelStatsDto }) {
  if (!hasAnyModelStatsData(stats)) {
    return (
      <p className="empty-message">モデル別の実績データはまだありません</p>
    );
  }

  const modelNames = collectModelNames(
    stats.weeklyCloses,
    stats.stageModelDistribution,
  );

  return (
    <>
      <div className="throughput-chart-block">
        <ChartBlockHeader
          heading="モデル別クローズ件数(週次)"
          description={CHART_DESCRIPTIONS.modelWeeklyCloses}
          level={4}
        />
        <ModelStatsTableScroll ariaLabel="モデル別クローズ件数(週次)（横スクロール可能）">
          <table className="model-stats-table">
            <thead>
              <tr>
                <th>週</th>
                {modelNames.map((model) => (
                  <th key={model}>{model}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {stats.weeklyCloses.map((entry) => (
                <tr key={entry.weekStart}>
                  <td>{formatWeekLabel(entry.weekStart)}</td>
                  {modelNames.map((model) => (
                    <td key={model}>{entry.counts[model] ?? 0}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </ModelStatsTableScroll>
      </div>
      <div className="throughput-chart-block">
        <ChartBlockHeader
          heading="工程×モデルの分布"
          description={CHART_DESCRIPTIONS.modelStageDistribution}
          level={4}
        />
        <ModelStatsTableScroll ariaLabel="工程×モデルの分布（横スクロール可能）">
          <table className="model-stats-table">
            <thead>
              <tr>
                <th>工程</th>
                {modelNames.map((model) => (
                  <th key={model}>{model}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {stats.stageModelDistribution.map((entry) => (
                <tr key={entry.stage}>
                  <td>{entry.stage}</td>
                  {modelNames.map((model) => (
                    <td key={model}>{entry.counts[model] ?? 0}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </ModelStatsTableScroll>
      </div>
    </>
  );
}

