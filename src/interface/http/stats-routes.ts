import { Hono } from 'hono';
import { parseClampedIntQueryParam } from './parse-clamped-int-query-param.js';
import { getThroughputStats } from '../../application/board/get-throughput-stats.js';
import { getModelStats } from '../../application/board/get-model-stats.js';
import { getHarnessKpi } from '../../application/board/get-harness-kpi.js';
import { getCfdStats } from '../../application/board/get-cfd-stats.js';
import { scanGitLeftovers } from '../../application/board/scan-git-leftovers.js';
import { describeFetchFailures } from '../../application/board/fetch-failure-log.js';
import type { LeftoverCandidate } from '../../domain/git-worktree.js';
import {
  toThroughputStatsDto,
  toModelStatsDto,
  toCfdStatsDto,
  toHarnessKpiDto,
} from './dto.js';
import { parseProjectIds } from './api-route-shared.js';
import type { ApiDeps } from './routes.js';

const STATS_DEFAULT_WEEKS = 8;
const STATS_MIN_WEEKS = 1;
const STATS_MAX_WEEKS = 26;

const CFD_DEFAULT_DAYS = 30;
const CFD_MIN_DAYS = 1;
const CFD_MAX_DAYS = 365;

function parseStatsWeeks(raw: string | undefined): number {
  return parseClampedIntQueryParam(raw, {
    min: STATS_MIN_WEEKS,
    max: STATS_MAX_WEEKS,
    defaultValue: STATS_DEFAULT_WEEKS,
  });
}

function parseCfdDays(raw: string | undefined): number {
  return parseClampedIntQueryParam(raw, {
    min: CFD_MIN_DAYS,
    max: CFD_MAX_DAYS,
    defaultValue: CFD_DEFAULT_DAYS,
  });
}

export function createStatsRoutes(deps: ApiDeps): Hono {
  const app = new Hono();

  app.get('/api/stats', (c) => {
    const projectIds = parseProjectIds(c.req.query('projects'));
    const weeks = parseStatsWeeks(c.req.query('weeks'));
    const stats = getThroughputStats(deps.cache, deps.now(), {
      ...(projectIds !== undefined ? { projectIds } : {}),
      weeks,
    });
    return c.json(toThroughputStatsDto(stats));
  });

  app.get('/api/model-stats', (c) => {
    const projectIds = parseProjectIds(c.req.query('projects'));
    const weeks = parseStatsWeeks(c.req.query('weeks'));
    const stats = getModelStats(deps.cache, deps.now(), {
      ...(projectIds !== undefined ? { projectIds } : {}),
      weeks,
    });
    return c.json(toModelStatsDto(stats));
  });

  app.get('/api/harness-kpi', async (c) => {
    const projectIds = parseProjectIds(c.req.query('projects'));
    const weeks = parseStatsWeeks(c.req.query('weeks'));
    const history = deps.reclaimHistory;

    // 誤回収件数 (reclaimedLiveWorktreeCount) の材料。/api/hygiene の
    // merged_leftover / reclaimed_live_worktree と同じ scanGitLeftovers を使い回す
    // (bdboard-t3ct)。scanner が無い、または一部でも git を読めなかったときは
    // 「0件」と断言できないので leftoverScanComplete=false を渡し、DTO 側で
    // count/rate を null にする (bdboard-t3ct M2)。
    let leftoverCandidates: readonly LeftoverCandidate[] | undefined;
    let leftoverScanComplete = false;
    if (deps.worktreeScanner !== undefined) {
      let entries = deps.cache.listProjects();
      if (projectIds !== undefined) {
        const filterSet = new Set(projectIds);
        entries = entries.filter((entry) => filterSet.has(entry.project.id));
      }
      const scan = await scanGitLeftovers(
        entries.map((entry) => entry.project),
        deps.worktreeScanner,
        {
          // m4 (bdboard-t3ct): [hygiene] パネル向けの既定文言だと、統計タブの
          // 誤回収件数が影響を受けたことが伝わらないので差し替える。
          describeFailure: (failures, totalCount) =>
            '[harness-kpi] could not scan git worktrees for some projects; ' +
            'misreclaim count on the stats tab is unavailable (shown as —). ' +
            describeFetchFailures(failures, totalCount),
        },
      );
      leftoverCandidates = scan.candidates;
      leftoverScanComplete = scan.complete;
    }

    const stats = getHarnessKpi(deps.cache, deps.now(), {
      ...(projectIds !== undefined ? { projectIds } : {}),
      weeks,
      ...(history !== undefined
        ? {
            reclaimRuns: history.list(),
            reclaimSince: history.since(),
            reclaimUnparsedRunCount: history.unparsedRunCount(),
          }
        : {}),
      ...(leftoverCandidates !== undefined ? { leftoverCandidates } : {}),
      leftoverScanComplete,
    });
    return c.json(toHarnessKpiDto(stats));
  });

  app.get('/api/cfd', (c) => {
    const projectIds = parseProjectIds(c.req.query('projects'));
    const days = parseCfdDays(c.req.query('days'));
    const stats = getCfdStats(deps.cache, deps.now(), {
      ...(projectIds !== undefined ? { projectIds } : {}),
      days,
    });
    return c.json(toCfdStatsDto(stats));
  });

  return app;
}
