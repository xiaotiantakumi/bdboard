// bdboard-sso1.51: reclaim-scheduler.ts のモジュール分割。回収スケジューラが公開する
// 型/インターフェースをまとめたモジュール (move only, 挙動変更ゼロ)。
import type { ReclaimRunRecord } from '../../../domain/harness-kpi.js';
import type { Project } from '../../../domain/project.js';
import type { ReclaimPlan } from '../../../domain/reclaim-plan.js';
import type { LeaseReclaimer } from '../../ports/lease-reclaimer.js';

export interface ReclaimProjectStatus {
  readonly projectId: string;
  readonly lastRunAt: string | null;
  readonly reclaimedCount: number | null;
  readonly reclaimedCountUnknown: boolean;
  readonly rawSummary: string | null;
  readonly lastError: string | null;
}

export interface ReclaimSchedulerStatus {
  readonly enabled: boolean;
  readonly intervalMs: number;
  readonly olderThan: string;
  readonly projects: readonly ReclaimProjectStatus[];
}

export interface ReclaimSchedulerConfig {
  readonly enabled: boolean;
  readonly intervalMs: number;
  readonly olderThan: string;
}

/**
 * reclaim が 1 回成功するたびに呼ばれる観測フック。ハーネス KPI 用のリングバッファ
 * (reclaim-history.ts) を積むために使う。**スケジューラ本体の挙動は変えない** —
 * observer が投げても reclaim の巡回は続く。
 */
export type ReclaimRunObserver = (run: ReclaimRunRecord) => void;

/**
 * 巡回を見送った理由 (bdboard-2hsq)。健全性表示から原因を追えるよう、読めなかった
 * 情報源ごとに分ける。
 *
 * - `lease-read-failed`: `bd list --status in_progress` (LeaseReader) を読めなかった
 * - `scan-incomplete`: `git worktree list` / `git branch --list bd/*` が非ゼロ終了・
 *   timeout・spawn 失敗のいずれかで、最後まで読めなかった (スキャナは throw せず
 *   `complete: false` の空スナップショットに畳む)
 * - `scan-failed`: スキャナ呼び出し自体が例外を投げた
 */
export type ReclaimSkipReason = 'lease-read-failed' | 'scan-incomplete' | 'scan-failed';

/**
 * planner の結果。`skipped` は「判断材料が無いので今回は見送る」で、呼び出し側は
 * bd を一切呼ばない。
 */
export type ReclaimPlanOutcome =
  | { readonly kind: 'plan'; readonly plan: ReclaimPlan }
  | { readonly kind: 'skipped'; readonly reason: ReclaimSkipReason };

/**
 * 回収前に「生存証拠のあるチケットを外す」計画を立てる (bdboard-6aci)。
 *
 * `skipped` を返したら **そのプロジェクトは今回スキップする**。判断材料が無いときに
 * 全件回収へフォールバックすると、この仕組みが防ごうとしている事故そのものが起きる。
 */
export type ReclaimPlanner = (project: Project) => Promise<ReclaimPlanOutcome>;

/**
 * 見送り理由ごとの健全性表示 (rawSummary)。以前は理由を問わず「生存証拠を判定
 * できませんでした」一本で、bd 側の失敗でも git の話に見えていた (bdboard-2hsq)。
 */
export function describeReclaimSkip(reason: ReclaimSkipReason): string {
  switch (reason) {
    case 'lease-read-failed':
      return 'skipped: bd の in_progress 一覧を読めませんでした';
    case 'scan-incomplete':
      return 'skipped: git の worktree / bd ブランチ一覧を最後まで読めず、生存証拠を判定できませんでした';
    case 'scan-failed':
      return 'skipped: git worktree を走査できず、生存証拠を判定できませんでした';
    default: {
      // 理由を足したのに表示を足し忘れたら tsc で落とす。
      const unreachable: never = reason;
      return `skipped: ${String(unreachable)}`;
    }
  }
}

export interface ReclaimSchedulerDeps {
  readonly reclaimer: LeaseReclaimer;
  readonly listProjects: () => readonly Project[];
  readonly config: ReclaimSchedulerConfig;
  readonly logError?: (message: string) => void;
  readonly observer?: ReclaimRunObserver;
  readonly planner: ReclaimPlanner;
}

export interface ReclaimScheduler {
  start(): void;
  stop(): void;
  getStatus(): ReclaimSchedulerStatus;
}

// create-scheduler.ts からの cross-module use のため export を付けている (元は
// reclaim-scheduler.ts 内の非公開 interface。公開エクスポート面には含めない — 入口の
// reclaim-scheduler.ts はこの型を re-export しない)。
export interface MutableProjectStatus {
  projectId: string;
  lastRunAt: Date | null;
  reclaimedCount: number | null;
  reclaimedCountUnknown: boolean;
  rawSummary: string | null;
  lastError: string | null;
}
