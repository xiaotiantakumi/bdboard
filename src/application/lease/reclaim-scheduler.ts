import { compareStrings } from '../../domain/compare.js';
import type { ReclaimRunRecord } from '../../domain/harness-kpi.js';
import type { Project } from '../../domain/project.js';
import type { ReclaimPlan } from '../../domain/reclaim-plan.js';
import { runWithConcurrencyLimit } from '../concurrency.js';
import type { LeaseReclaimer } from '../ports/lease-reclaimer.js';
import { parseReclaimStdout } from './parse-reclaim-output.js';

const PROJECT_SCAN_CONCURRENCY = 3;

export const DEFAULT_RECLAIM_INTERVAL_MS = 5 * 60_000;

/**
 * lease 失効からこの猶予窓を過ぎたチケットだけを回収する。
 *
 * **10m から 2h へ引き上げた (bdboard-hybu)。** 旧既定は bd 側の「猶予は claim TTL の
 * 約2倍」という説明をそのまま採ったものだったが、TTL(≈5分) の2倍という尺度は
 * 「heartbeat が動いていれば失効しない」という前提の上でしか意味を持たない。実際には
 * heartbeat は打たれておらず、2026-09-05 に **生存セッションのチケット4件が作業中に
 * 回収された** (bdboard-okdh / 53my / s0o7 / s1vj)。いずれも claim から 15〜19 分後に
 * open へ戻され、その直後に当人が PR を出しているため、`bd ready` が「PR が飛んでいる
 * チケット」を空きとして提示した。
 *
 * 猶予窓が守るべきなのは TTL の倍数ではなく **1チケットの実作業時間** である。実測の
 * 15〜19 分はごく短い部類で、レビュー往復や verify 待ちを含む通常のチケットは数時間
 * かかる。**2h でもその全部は覆えない** — 覆えるのは実測された被害帯に 6 倍以上の余裕を
 * 持たせるところまでで、数時間かかるチケットは heartbeat が生きていることに依存し続ける。
 * それでも 2h を採るのは、本来の目的 (死んだセッションのチケットが永久に in_progress で
 * 塩漬けになるのを防ぐ) を最大 2h10m の遅延 (猶予窓 2h + 巡回間隔 5m + lease TTL 5m) で
 * 維持したまま、実測の事故を確実に外せる最小の値だから。
 *
 * これは**対症療法**である。恒久対策は「生存証拠を見てから回収する」(bdboard-6aci) で、
 * そちらが入れば猶予窓は本来の役割 (死活判定の遅延吸収) に戻せる。
 */
export const DEFAULT_RECLAIM_OLDER_THAN = '2h';

/**
 * 猶予窓の下限 (ミリ秒)。`DEFAULT_RECLAIM_OLDER_THAN` がこれを下回ると
 * 「作業中のチケットを回収する」既定に逆戻りするため、テストで固定している。
 */
export const MIN_SAFE_RECLAIM_OLDER_THAN_MS = 60 * 60_000;

/**
 * bd の duration 文字列 (`10m` / `2h` / `1h30m` / `90s`) をミリ秒に直す。
 * 解釈できない入力は undefined を返す — 呼び出し側が「検査できなかった」を
 * 「安全だった」と取り違えないようにするため、既定値へのフォールバックはしない。
 */
export function parseReclaimDurationMs(value: string): number | undefined {
  const trimmed = value.trim();
  // 先に全体形を固定してから足し上げる。部分一致で「検査できた」ことにすると、
  // `2 hours` のような入力が 2h として通り、下限チェックが黙って素通りする。
  if (!/^(\d+[hms])+$/.test(trimmed)) {
    return undefined;
  }
  const unitMs: Record<string, number> = { h: 3_600_000, m: 60_000, s: 1_000 };
  let total = 0;
  for (const match of trimmed.matchAll(/(\d+)([hms])/g)) {
    total += Number(match[1]) * (unitMs[match[2] as string] as number);
  }
  return total;
}

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
 * 回収前に「生存証拠のあるチケットを外す」計画を立てる (bdboard-6aci)。
 *
 * `null` を返したら **そのプロジェクトは今回スキップする**。判断材料が無いときに
 * 全件回収へフォールバックすると、この仕組みが防ごうとしている事故そのものが起きる。
 * 未指定なら計画を挟まず従来どおりプロジェクト全体を対象にする。
 */
export type ReclaimPlanner = (project: Project) => Promise<ReclaimPlan | null>;

export interface ReclaimSchedulerDeps {
  readonly reclaimer: LeaseReclaimer;
  readonly listProjects: () => readonly Project[];
  readonly config: ReclaimSchedulerConfig;
  readonly logError?: (message: string) => void;
  readonly observer?: ReclaimRunObserver;
  readonly planner?: ReclaimPlanner;
}

export interface ReclaimScheduler {
  start(): void;
  stop(): void;
  getStatus(): ReclaimSchedulerStatus;
}

interface MutableProjectStatus {
  projectId: string;
  lastRunAt: Date | null;
  reclaimedCount: number | null;
  reclaimedCountUnknown: boolean;
  rawSummary: string | null;
  lastError: string | null;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function summarizeFailure(
  exitCode: number,
  stdout: string,
  stderr: string,
  failureKind?: string,
): string {
  const parts = [
    failureKind !== undefined ? `failure=${failureKind}` : undefined,
    `exit=${exitCode}`,
    stdout.trim().length > 0 ? `stdout=${stdout.trim()}` : undefined,
    stderr.trim().length > 0 ? `stderr=${stderr.trim()}` : undefined,
  ].filter((part) => part !== undefined);
  return parts.join('; ') || `exit code ${exitCode}`;
}

export function createReclaimScheduler(deps: ReclaimSchedulerDeps): ReclaimScheduler {
  const { reclaimer, listProjects, config } = deps;
  const logError = deps.logError ?? ((message: string) => console.error(message));

  const statusByProjectId = new Map<string, MutableProjectStatus>();
  let intervalTimer: ReturnType<typeof setInterval> | undefined;
  let running = false;

  const ensureProjectStatus = (projectId: string): MutableProjectStatus => {
    let entry = statusByProjectId.get(projectId);
    if (entry === undefined) {
      entry = {
        projectId,
        lastRunAt: null,
        reclaimedCount: null,
        reclaimedCountUnknown: false,
        rawSummary: null,
        lastError: null,
      };
      statusByProjectId.set(projectId, entry);
    }
    return entry;
  };

  const notifyObserver = (run: ReclaimRunRecord): void => {
    const observer = deps.observer;
    if (observer === undefined) {
      return;
    }
    try {
      observer(run);
    } catch (err) {
      // 観測は付随機能。ここで巡回を止めない。
      logError(`Reclaim observer failed for project=${run.projectId}: ${errorMessage(err)}`);
    }
  };

  const runForProject = async (project: Project): Promise<void> => {
    const entry = ensureProjectStatus(project.id);
    try {
      let plan: ReclaimPlan | undefined;
      if (deps.planner !== undefined) {
        const planned = await deps.planner(project);
        if (planned === null) {
          // 判断材料が無い。全件回収へ落とすくらいなら 1 周見送る (回収漏れは次の
          // 巡回で取り返せるが、生きている作業を奪うのは取り返せない)。
          entry.lastRunAt = new Date();
          entry.reclaimedCount = 0;
          entry.reclaimedCountUnknown = false;
          entry.rawSummary = 'skipped: 生存証拠を判定できませんでした';
          entry.lastError = null;
          return;
        }
        plan = planned;

        if (plan.reclaimTicketIds.length === 0) {
          // **ここで bd を呼んではいけない。** `--id` 無しの reclaim は全件対象になる。
          entry.lastRunAt = new Date();
          entry.reclaimedCount = 0;
          entry.reclaimedCountUnknown = false;
          entry.rawSummary =
            plan.protectedTicketIds.length > 0
              ? `protected ${plan.protectedTicketIds.length} (worktree が生きているため回収しませんでした)`
              : null;
          entry.lastError = null;
          return;
        }
      }

      const result =
        plan === undefined
          ? await reclaimer.reclaim(project.rootPath, config.olderThan)
          : await reclaimer.reclaim(project.rootPath, config.olderThan, plan.reclaimTicketIds);
      const runAt = new Date();
      entry.lastRunAt = runAt;

      if (result.exitCode !== 0 || result.failureKind !== undefined) {
        entry.reclaimedCount = null;
        entry.reclaimedCountUnknown = true;
        entry.rawSummary = null;
        entry.lastError = summarizeFailure(
          result.exitCode,
          result.stdout,
          result.stderr,
          result.failureKind,
        );
        logError(
          `Reclaim failed for project=${project.id}: ${entry.lastError}`,
        );
        return;
      }

      const parsed = parseReclaimStdout(result.stdout);
      entry.reclaimedCount = parsed.count;
      entry.reclaimedCountUnknown = parsed.count === null;
      const protectedNote =
        plan !== undefined && plan.protectedTicketIds.length > 0
          ? `protected ${plan.protectedTicketIds.length}`
          : null;
      const summaryParts = [
        parsed.summary.length > 0 ? parsed.summary : null,
        protectedNote,
      ].filter((part): part is string => part !== null);
      entry.rawSummary = summaryParts.length > 0 ? summaryParts.join('; ') : null;
      entry.lastError = null;

      notifyObserver({
        projectId: project.id,
        at: runAt,
        reclaimedCount: parsed.count,
        ticketIds: parsed.ticketIds,
      });
    } catch (err) {
      entry.lastRunAt = new Date();
      entry.reclaimedCount = null;
      entry.reclaimedCountUnknown = true;
      entry.rawSummary = null;
      entry.lastError = errorMessage(err);
      logError(`Reclaim failed for project=${project.id}: ${entry.lastError}`);
    }
  };

  const runCycle = async (): Promise<void> => {
    if (running) {
      return;
    }

    running = true;
    try {
      const projects = listProjects();
      await runWithConcurrencyLimit(projects, PROJECT_SCAN_CONCURRENCY, runForProject);
    } finally {
      running = false;
    }
  };

  const snapshotStatus = (): ReclaimSchedulerStatus => {
    const projects = listProjects();
    const seen = new Set<string>();
    const projectStatuses: ReclaimProjectStatus[] = [];

    for (const project of projects) {
      seen.add(project.id);
      const entry = ensureProjectStatus(project.id);
      projectStatuses.push({
        projectId: entry.projectId,
        lastRunAt: entry.lastRunAt?.toISOString() ?? null,
        reclaimedCount: entry.reclaimedCount,
        reclaimedCountUnknown: entry.reclaimedCountUnknown,
        rawSummary: entry.rawSummary,
        lastError: entry.lastError,
      });
    }

    for (const [projectId, entry] of statusByProjectId) {
      if (seen.has(projectId)) {
        continue;
      }
      projectStatuses.push({
        projectId: entry.projectId,
        lastRunAt: entry.lastRunAt?.toISOString() ?? null,
        reclaimedCount: entry.reclaimedCount,
        reclaimedCountUnknown: entry.reclaimedCountUnknown,
        rawSummary: entry.rawSummary,
        lastError: entry.lastError,
      });
    }

    projectStatuses.sort((a, b) => compareStrings(a.projectId, b.projectId));

    return {
      enabled: config.enabled,
      intervalMs: config.intervalMs,
      olderThan: config.olderThan,
      projects: projectStatuses,
    };
  };

  return {
    start() {
      if (!config.enabled || config.intervalMs <= 0) {
        return;
      }
      if (intervalTimer !== undefined) {
        return;
      }

      intervalTimer = setInterval(() => {
        void runCycle();
      }, config.intervalMs);
      intervalTimer.unref?.();

      void runCycle();
    },

    stop() {
      if (intervalTimer !== undefined) {
        clearInterval(intervalTimer);
        intervalTimer = undefined;
      }
    },

    getStatus() {
      return snapshotStatus();
    },
  };
}
