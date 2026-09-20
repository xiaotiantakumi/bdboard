// bdboard-sso1.12: dto.ts のモジュール分割。ハーネス KPI (確認待ち滞留・回収・
// harness ラベル/重複言及の一致率) の DTO。stats-routes.ts が参照する (barrel 経由)。
import type { HarnessKpiStats } from '../../../application/board/get-harness-kpi.js';

export interface PendingDecisionDwellKpiDto {
  /** 確認待ちのまま close されたチケット数 (期間内) */
  closedCount: number;
  closedGateCount: number;
  closedWorkCount: number;
  /** 未クローズの確認待ち件数。期間によらない現在値 */
  openCount: number;
  openGateCount: number;
  openWorkCount: number;
  medianMs: number | null;
  p90Ms: number | null;
  /** 'created' = ラベル付与時刻が取れないので作成時刻で代替している */
  anchor: 'created';
}

export interface ReclaimKpiDto {
  runCount: number;
  reclaimedCountTotal: number;
  unknownCountRunCount: number;
  identifiedTicketCount: number;
  reclaimedThenInProgressCount: number;
  reclaimedThenInProgressRate: number | null;
  windowMs: number;
  /**
   * この統計が「いつ以降」のものか (= サーバー起動時刻、バッファが溢れた後は
   * 残っている最古の実行時刻)。永続化していないので UI に注記する
   */
  since: string | null;
  /** 出力を読めず履歴に積めなかった実行の累積回数 */
  unparsedRunCount: number;
  /**
   * 誤回収件数。identifiedTicketCount のうち、いま見えている生存証拠
   * (worktree/ブランチ、bdboard-rkde と同じ判定 + open ゲート) がある数
   * (bdboard-t3ct)。git worktree スキャンが不完全 (一部プロジェクトで失敗した、
   * または scanner 未設定) なら null — 「0件」と「読めなかった」を混同しない
   * ため (bdboard-t3ct M2)。UI は — を表示する。
   */
  reclaimedLiveWorktreeCount: number | null;
  /** 母数 (identifiedTicketCount) が 0、またはスキャンが不完全なら null */
  reclaimedLiveWorktreeRate: number | null;
}

export interface HarnessShareKpiDto {
  matchedCount: number;
  totalCount: number;
  rate: number | null;
}

export interface HarnessKpiDto {
  rangeStart: string;
  rangeEnd: string;
  pendingDecisionDwell: PendingDecisionDwellKpiDto;
  reclaim: ReclaimKpiDto;
  harnessLabeled: HarnessShareKpiDto;
  duplicateMention: HarnessShareKpiDto;
}

export function toHarnessKpiDto(stats: HarnessKpiStats): HarnessKpiDto {
  const { kpi } = stats;
  return {
    rangeStart: kpi.rangeStart.toISOString(),
    rangeEnd: kpi.rangeEnd.toISOString(),
    pendingDecisionDwell: {
      closedCount: kpi.pendingDecisionDwell.closedCount,
      closedGateCount: kpi.pendingDecisionDwell.closedGateCount,
      closedWorkCount: kpi.pendingDecisionDwell.closedWorkCount,
      openCount: kpi.pendingDecisionDwell.openCount,
      openGateCount: kpi.pendingDecisionDwell.openGateCount,
      openWorkCount: kpi.pendingDecisionDwell.openWorkCount,
      medianMs: kpi.pendingDecisionDwell.medianMs,
      p90Ms: kpi.pendingDecisionDwell.p90Ms,
      anchor: kpi.pendingDecisionDwell.anchor,
    },
    reclaim: {
      runCount: kpi.reclaim.runCount,
      reclaimedCountTotal: kpi.reclaim.reclaimedCountTotal,
      unknownCountRunCount: kpi.reclaim.unknownCountRunCount,
      identifiedTicketCount: kpi.reclaim.identifiedTicketCount,
      reclaimedThenInProgressCount: kpi.reclaim.reclaimedThenInProgressCount,
      reclaimedThenInProgressRate: kpi.reclaim.reclaimedThenInProgressRate,
      windowMs: kpi.reclaim.windowMs,
      since: stats.reclaimSince?.toISOString() ?? null,
      unparsedRunCount: stats.reclaimUnparsedRunCount,
      // スキャンが不完全なら「0件」と断言できないので null にする (bdboard-t3ct M2)。
      reclaimedLiveWorktreeCount: stats.leftoverScanComplete
        ? kpi.reclaim.reclaimedLiveWorktreeCount
        : null,
      reclaimedLiveWorktreeRate: stats.leftoverScanComplete
        ? kpi.reclaim.reclaimedLiveWorktreeRate
        : null,
    },
    harnessLabeled: { ...kpi.harnessLabeled },
    duplicateMention: { ...kpi.duplicateMention },
  };
}
