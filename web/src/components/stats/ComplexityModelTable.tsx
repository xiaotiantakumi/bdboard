// bdboard-p5l.27: 複雑度 (bdboard.complexity) × 実装モデル (bdboard.model.implement) ×
// 修正 push 回数の表。「モデル別実績」ブロックの一部で、既存の2表と同じ
// ModelStatsTableScroll に載せる (列が増えても横スクロールで全セルに届く: bdboard-83tc)。
import type { ComplexityModelRowDto, ComplexityModelStatsDto } from '../../api';
import { CHART_DESCRIPTIONS } from './constants';
import { ChartBlockHeader } from './ChartBlockHeader';
import { ModelStatsTableScroll } from '../ModelStatsTableScroll';

/** メタデータが記録されていないチケットの行ラベル。 */
export const UNRECORDED_LABEL = '未記録';

const UNKNOWN_VALUE = '—';

function formatAverage(row: ComplexityModelRowDto): string {
  return row.fixPushAverage === null ? UNKNOWN_VALUE : row.fixPushAverage.toFixed(1);
}

function formatTotal(row: ComplexityModelRowDto): string {
  return row.fixPushKnownCount === 0 ? UNKNOWN_VALUE : String(row.fixPushTotal);
}

export function ComplexityModelTable({ stats }: { stats: ComplexityModelStatsDto }) {
  return (
    <div className="throughput-chart-block">
      <ChartBlockHeader
        heading="複雑度×実装モデルの修正push"
        description={CHART_DESCRIPTIONS.modelComplexityFixPush}
        level={4}
      />
      {stats.rows.length === 0 ? (
        <p className="empty-message">
          複雑度または実装モデルが記録されたクローズ済みチケットはまだありません
        </p>
      ) : (
        <ModelStatsTableScroll ariaLabel="複雑度×実装モデルの修正push（横スクロール可能）">
          <table className="model-stats-table">
            <thead>
              <tr>
                <th>複雑度</th>
                <th>実装モデル</th>
                <th>クローズ件数</th>
                <th>修正push平均</th>
                <th>修正push合計</th>
                <th>回数あり件数</th>
                <th>回数不明件数</th>
              </tr>
            </thead>
            <tbody>
              {stats.rows.map((row) => (
                <tr key={`${row.complexity ?? ''}\u0000${row.model ?? ''}`}>
                  <td>{row.complexity ?? UNRECORDED_LABEL}</td>
                  <td>{row.model ?? UNRECORDED_LABEL}</td>
                  <td>{row.ticketCount}</td>
                  <td>{formatAverage(row)}</td>
                  <td>{formatTotal(row)}</td>
                  <td>{row.fixPushKnownCount}</td>
                  <td>{row.fixPushUnknownCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </ModelStatsTableScroll>
      )}
      {stats.fixPushPendingCount > 0 && (
        <p className="throughput-chart-description" role="status">
          修正push回数を取得中のチケットが {stats.fixPushPendingCount} 件あります
          (取得でき次第、自動で更新されます)。
        </p>
      )}
      {stats.unrecordedTicketCount > 0 && (
        <p className="throughput-chart-description">
          複雑度も実装モデルも未記録のクローズ済みチケット {stats.unrecordedTicketCount}{' '}
          件は、この表に含めていません。
        </p>
      )}
    </div>
  );
}
