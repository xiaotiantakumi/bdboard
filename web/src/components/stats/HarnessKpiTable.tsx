// bdboard-sso1.20: ThroughputStats.tsx から自己完結した表示専用コンポーネントを
// 移動しただけのファイル。挙動は一切変えていない。
import type { HarnessKpiDto } from '../../api';
import { ModelStatsTableScroll } from '../ModelStatsTableScroll';
import {
  formatCount,
  formatDurationMs,
  formatKpiTimestamp,
  formatRatePercent,
  formatShare,
} from '../throughputStatsFormatting';

export function HarnessKpiTable({ kpi }: { kpi: HarnessKpiDto }) {
  const dwell = kpi.pendingDecisionDwell;
  const reclaim = kpi.reclaim;

  const rows: readonly {
    key: string;
    label: string;
    value: string;
    note: string;
  }[] = [
    {
      key: 'pending-decision-dwell',
      label: '確認待ちのままクローズしたチケットの滞留 (中央値 / p90)',
      value: `${formatDurationMs(dwell.medianMs)} / ${formatDurationMs(dwell.p90Ms)}`,
      note:
        `期間内にクローズ ${dwell.closedCount}件 (gate ${dwell.closedGateCount} / 作業 ` +
        `${dwell.closedWorkCount})、未回答 ${dwell.openCount}件 (gate ${dwell.openGateCount} / 作業 ` +
        `${dwell.openWorkCount}、期間によらず現在値)。gate は回答＝クローズなので入りますが、` +
        '回答時に human ラベルだけを外した作業チケットはクローズされないため含まれません。' +
        'ラベル付与時刻は bd から取れないため作成時刻を起点にしています。',
    },
    {
      key: 'reclaim',
      label: 'reclaim 発火 / 直後の再 claim 率',
      value: `${reclaim.runCount}回 / ${formatRatePercent(reclaim.reclaimedThenInProgressRate)}`,
      note:
        `回収 ${reclaim.reclaimedCountTotal}件のうち ID を追えた ${reclaim.identifiedTicketCount}件中 ` +
        `${reclaim.reclaimedThenInProgressCount}件が ${Math.round(reclaim.windowMs / 60_000)}分以内に` +
        `再び作業中になりました。判定に使えるのは現在の作業開始時刻だけなので、` +
        `厳密な再 claim 検出ではなく誤回収の代理指標です。記録は ` +
        `${formatKpiTimestamp(reclaim.since)} 以降のみで、保存されません` +
        `${reclaim.unparsedRunCount > 0 ? ` (出力を読めず除外した実行 ${reclaim.unparsedRunCount}回)` : ''}。`,
    },
    {
      key: 'reclaim-live-worktree',
      label: '誤回収件数 / 率',
      value: `${formatCount(reclaim.reclaimedLiveWorktreeCount)} / ${formatRatePercent(reclaim.reclaimedLiveWorktreeRate)}`,
      note:
        `ID を追えた ${reclaim.identifiedTicketCount}件のうち、いま見ても open のまま ` +
        `worktree かブランチが残っている (＝作業中に回収された疑いがある) チケットの` +
        '数です。Hygiene の「reclaimed_live_worktree」と同じ生存判定 (open ゲート込み)' +
        'を使っていますが、見ているのは回収時点ではなく現時点の生存証拠なので、' +
        '回収後すぐに掃除された誤回収は数え損ない、逆に掃除がまだ終わっていないだけの' +
        '盤面と区別も付きません。過小にも過大にも振れるため実測値の下限ではありません。' +
        '一部のプロジェクトで git を読めなかった、または git スキャン自体が未設定の' +
        'ときは件数・率とも — を表示します。',
    },
    {
      key: 'harness-labeled',
      label: 'ハーネス起票率',
      value: formatShare(
        kpi.harnessLabeled.matchedCount,
        kpi.harnessLabeled.totalCount,
        kpi.harnessLabeled.rate,
      ),
      note: '期間内に作成されたチケットのうち harness / harness-upstream ラベルが付いた割合。',
    },
    {
      key: 'duplicate-mention',
      label: '重複 / 再発チケット比率',
      value: formatShare(
        kpi.duplicateMention.matchedCount,
        kpi.duplicateMention.totalCount,
        kpi.duplicateMention.rate,
      ),
      note:
        'タイトルまたは本文に「重複 / duplicate / 再発 / 二重 / 統合」を含む割合。' +
        '単語の一致だけを見る粗い指標なので、傾向の増減として読んでください。',
    },
  ];

  return (
    <div className="throughput-chart-block">
      <ModelStatsTableScroll ariaLabel="ハーネスKPI（横スクロール可能）">
        <table className="model-stats-table">
          <thead>
            <tr>
              <th>指標</th>
              <th>値</th>
              <th>読み方</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key}>
                <td>{row.label}</td>
                <td>{row.value}</td>
                <td>{row.note}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </ModelStatsTableScroll>
    </div>
  );
}

