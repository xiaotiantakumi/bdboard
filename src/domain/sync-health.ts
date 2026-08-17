export type SyncHealthStatus = 'ok' | 'attention' | 'unknown';

export type SyncHealthReasonKind =
  | 'diverged_from_remote'
  | 'stale_export'
  | 'uncommitted_interactions'
  | 'no_dolt_ref';

export interface SyncHealthReason {
  readonly kind: SyncHealthReasonKind;
  readonly message: string;
}

export interface SyncHealth {
  readonly projectId: string;
  readonly status: SyncHealthStatus;
  readonly reasons: readonly SyncHealthReason[];
}

/** infrastructure層のgitアダプタが集めてくる生シグナル。IOの結果を表すだけの値。 */
export interface SyncHealthSignals {
  /** `git rev-parse --verify refs/dolt/data` のローカルhash。refが無ければ null */
  readonly localDoltRefHash: string | null;
  /** ローカル refs/dolt/data の最終コミット時刻(epoch ms)。localDoltRefHashがnullならnull */
  readonly localDoltRefCommitMs: number | null;
  /** リモート(originなど)の refs/dolt/data hash。取得できなければ null */
  readonly remoteDoltRefHash: string | null;
  /** `.beads/issues.jsonl` の mtime(epoch ms)。無ければ null */
  readonly issuesJsonlMtimeMs: number | null;
  /** `.beads/interactions.jsonl` がgit的に未コミット(変更 or 未追跡)か */
  readonly interactionsUncommitted: boolean;
}

export interface SyncHealthThresholds {
  /** localDoltRefCommitMs と issuesJsonlMtimeMs の差がこれを超えたら stale_export。既定 24時間 */
  readonly staleExportAfterMs: number;
}

export const DEFAULT_SYNC_HEALTH_THRESHOLDS: SyncHealthThresholds = {
  staleExportAfterMs: 24 * 60 * 60_000,
};

export function evaluateSyncHealth(
  projectId: string,
  signals: SyncHealthSignals,
  thresholds?: SyncHealthThresholds,
): SyncHealth {
  const resolvedThresholds = thresholds ?? DEFAULT_SYNC_HEALTH_THRESHOLDS;

  if (signals.localDoltRefHash === null) {
    return {
      projectId,
      status: 'unknown',
      reasons: [
        {
          kind: 'no_dolt_ref',
          message: 'refs/dolt/data がローカルに見つかりません',
        },
      ],
    };
  }

  const reasons: SyncHealthReason[] = [];

  if (
    signals.remoteDoltRefHash !== null &&
    signals.remoteDoltRefHash !== signals.localDoltRefHash
  ) {
    reasons.push({
      kind: 'diverged_from_remote',
      message: 'ローカルの refs/dolt/data がリモートと一致していません',
    });
  }

  if (
    signals.localDoltRefCommitMs !== null &&
    signals.issuesJsonlMtimeMs !== null &&
    signals.localDoltRefCommitMs - signals.issuesJsonlMtimeMs >
      resolvedThresholds.staleExportAfterMs
  ) {
    reasons.push({
      kind: 'stale_export',
      message: '.beads/issues.jsonl のエクスポートが古い可能性があります',
    });
  }

  if (signals.interactionsUncommitted) {
    reasons.push({
      kind: 'uncommitted_interactions',
      message: '.beads/interactions.jsonl に未コミットの変更があります',
    });
  }

  return {
    projectId,
    status: reasons.length > 0 ? 'attention' : 'ok',
    reasons,
  };
}
