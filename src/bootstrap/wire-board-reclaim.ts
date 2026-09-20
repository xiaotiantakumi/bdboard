/**
 * bdboard-sso1.14: src/main.ts (composition root) からリース回収
 * (reclaim scheduler) 領域の配線を切り出したもの (move only, 挙動変更ゼロ)。
 */
import type { BoardCache } from '../application/ports/board-cache.js';
import type { LeaseReader } from '../application/ports/lease-reader.js';
import type { LeaseReclaimer } from '../application/ports/lease-reclaimer.js';
import type { WorktreeScanner } from '../application/ports/worktree-scanner.js';
import {
  createReclaimScheduler,
  parseReclaimDurationMs,
  MIN_SAFE_RECLAIM_OLDER_THAN_MS,
} from '../application/lease/reclaim-scheduler.js';
import { createReclaimHistory } from '../application/lease/reclaim-history.js';
import { planProjectReclaim } from '../application/lease/plan-project-reclaim.js';

export interface WireBoardReclaimDeps {
  readonly leaseReclaimer: LeaseReclaimer;
  readonly leaseReader: LeaseReader;
  readonly worktreeScanner: WorktreeScanner;
  readonly cache: BoardCache;
  readonly reclaimEnabled: boolean;
  readonly reclaimIntervalMs: number;
  readonly reclaimOlderThan: string;
  readonly log?: (message: string) => void;
  readonly logError?: (message: string) => void;
  readonly logWarn?: (message: string) => void;
}

/**
 * ハーネス KPI 用の reclaim 記録 (bdboard-pkr6.9)。サーバー起動からの累積で
 * 永続化しない — 起動時刻を UI に注記して読ませる。
 */
export function wireBoardReclaim(deps: WireBoardReclaimDeps) {
  const log = deps.log ?? console.log;
  const logError = deps.logError ?? console.error;
  const logWarn = deps.logWarn ?? console.warn;

  const reclaimHistory = createReclaimHistory();
  const reclaimScheduler = createReclaimScheduler({
    reclaimer: deps.leaseReclaimer,
    listProjects: () => deps.cache.listProjects().map((entry) => entry.project),
    config: {
      enabled: deps.reclaimEnabled,
      intervalMs: deps.reclaimIntervalMs,
      olderThan: deps.reclaimOlderThan,
    },
    logError: (message) => {
      logError(message);
    },
    observer: (run) => {
      reclaimHistory.record(run);
    },
    // 生存証拠 (worktree/ブランチ) のあるチケットを回収対象から外す (bdboard-6aci)。
    // in_progress 集合と lease 失効時刻は LeaseReader の生値から取る — 盤面キャッシュ
    // は使わない (bdboard-vz01)。
    planner: (project) =>
      planProjectReclaim(project, {
        leaseReader: deps.leaseReader,
        scanner: deps.worktreeScanner,
        logWarn: (message) => {
          logWarn(message);
        },
      }),
  });
  reclaimScheduler.start();

  if (deps.reclaimEnabled) {
    log(
      `Lease reclaim: enabled (interval=${deps.reclaimIntervalMs}ms older-than=${deps.reclaimOlderThan})`,
    );
    // 既定値はテストで下限に固定してあるが、env で上書きされた値は誰も検査しない。
    // 猶予窓を短くする設定は「作業中のチケットを回収する」既定へ逆戻りさせるので、
    // 起動時に一度だけ警告する (bdboard-hybu)。
    const reclaimOlderThanMs = parseReclaimDurationMs(deps.reclaimOlderThan);
    if (reclaimOlderThanMs === undefined) {
      logWarn(
        `Lease reclaim: BDBOARD_RECLAIM_OLDER_THAN=${deps.reclaimOlderThan} を duration として` +
          '解釈できませんでした。値の妥当性は検査していません (bd 側の解釈に委ねます)',
      );
    } else if (reclaimOlderThanMs < MIN_SAFE_RECLAIM_OLDER_THAN_MS) {
      logWarn(
        `Lease reclaim: 猶予窓 ${deps.reclaimOlderThan} は推奨下限 ` +
          `${MIN_SAFE_RECLAIM_OLDER_THAN_MS / 60_000}m を下回っています。heartbeat が一時的に` +
          '途切れただけの作業中チケットが回収されるおそれがあります (bdboard-hybu)',
      );
    }
  } else {
    log('Lease reclaim: disabled');
  }

  return { reclaimScheduler, reclaimHistory };
}
