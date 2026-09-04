import { compareStrings } from '../../domain/compare.js';
import type { ReclaimRunRecord } from '../../domain/harness-kpi.js';
import type { Project } from '../../domain/project.js';
import { runWithConcurrencyLimit } from '../concurrency.js';
import type { LeaseReclaimer } from '../ports/lease-reclaimer.js';
import { parseReclaimStdout } from './parse-reclaim-output.js';

const PROJECT_SCAN_CONCURRENCY = 3;

export const DEFAULT_RECLAIM_INTERVAL_MS = 5 * 60_000;
export const DEFAULT_RECLAIM_OLDER_THAN = '10m';

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

export interface ReclaimSchedulerDeps {
  readonly reclaimer: LeaseReclaimer;
  readonly listProjects: () => readonly Project[];
  readonly config: ReclaimSchedulerConfig;
  readonly logError?: (message: string) => void;
  readonly observer?: ReclaimRunObserver;
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
      const result = await reclaimer.reclaim(project.rootPath, config.olderThan);
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
      entry.rawSummary = parsed.summary.length > 0 ? parsed.summary : null;
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
