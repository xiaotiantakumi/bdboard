// src/application/lease/reclaim-scheduler.ts は bdboard-sso1.51 でモジュール分割された。実体は
// ./reclaim-scheduler/ 配下。このファイルは import 側 (dto/hygiene-status・build-api-deps・
// routes・main・bootstrap/wire-board-reclaim 等) を書き換えないための re-export 入口として
// のみ残す。挙動・型は一切変えていない (移動のみ)。分割の内訳・回帰ガードは
// reclaim-scheduler.exportSurface.test.ts / reclaim-scheduler-type-export-surface.check.ts。
export type {
  ReclaimProjectStatus,
  ReclaimSchedulerStatus,
  ReclaimSchedulerConfig,
  ReclaimRunObserver,
  ReclaimSkipReason,
  ReclaimPlanOutcome,
  ReclaimPlanner,
  ReclaimSchedulerDeps,
  ReclaimScheduler,
} from './reclaim-scheduler/types.js';

export {
  DEFAULT_RECLAIM_INTERVAL_MS,
  DEFAULT_RECLAIM_OLDER_THAN,
  MIN_SAFE_RECLAIM_OLDER_THAN_MS,
  parseReclaimDurationMs,
} from './reclaim-scheduler/duration.js';

export { describeReclaimSkip } from './reclaim-scheduler/skip-reason.js';

export { createReclaimScheduler } from './reclaim-scheduler/create-scheduler.js';
