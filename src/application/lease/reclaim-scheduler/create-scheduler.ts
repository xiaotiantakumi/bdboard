// bdboard-sso1.51: reclaim-scheduler.ts のモジュール分割。タイマー管理・回収対象の判定・
// 回収の実行・結果の記録が同居する createReclaimScheduler 本体をまとめたモジュール
// (move only, 挙動変更ゼロ)。これらはタイマーの登録順・停止処理・再入防止フラグ
// (running)・プロジェクト別状態 (statusByProjectId) を同じクロージャで共有しているため、
// 分割時にオブジェクト参照を分けずそのまま1関数として移した。
import { compareStrings } from '../../../domain/compare.js';
import type { ReclaimRunRecord } from '../../../domain/harness-kpi.js';
import type { Project } from '../../../domain/project.js';
import { runWithConcurrencyLimit } from '../../concurrency.js';
import { parseReclaimStdout } from '../parse-reclaim-output.js';
import { errorMessage, summarizeFailure } from './failure-summary.js';
import { describeReclaimSkip } from './skip-reason.js';
import type {
  MutableProjectStatus,
  ReclaimProjectStatus,
  ReclaimScheduler,
  ReclaimSchedulerDeps,
  ReclaimSchedulerStatus,
} from './types.js';

const PROJECT_SCAN_CONCURRENCY = 3;

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
      const outcome = await deps.planner(project);
      if (outcome.kind === 'skipped') {
        // 判断材料が無い。全件回収へ落とすくらいなら 1 周見送る (回収漏れは次の
        // 巡回で取り返せるが、生きている作業を奪うのは取り返せない)。
        entry.lastRunAt = new Date();
        // 「0 件回収した」とは言えない。何件回収すべきだったかを知らないまま
        // 見送ったので、件数は unknown として表示する。
        entry.reclaimedCount = null;
        entry.reclaimedCountUnknown = true;
        entry.rawSummary = describeReclaimSkip(outcome.reason);
        entry.lastError = null;
        return;
      }
      const { plan } = outcome;

      // `| undefined` を明示するのが要点。分割代入だと (noUncheckedIndexedAccess が
      // 無い今の tsconfig では) 型が `string` になり、下のガードを消しても tsc が通る。
      // ここを undefined 込みで受けておけば、ガードの削除が TS2322 で落ちる。
      const firstTicketId: string | undefined = plan.reclaimTicketIds[0];
      if (firstTicketId === undefined) {
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

      const result = await reclaimer.reclaim(project.rootPath, config.olderThan, [
        firstTicketId,
        ...plan.reclaimTicketIds.slice(1),
      ]);
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
        plan.protectedTicketIds.length > 0
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
