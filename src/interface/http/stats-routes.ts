import { Hono } from 'hono';
import { parseClampedIntQueryParam } from './parse-clamped-int-query-param.js';
import { getThroughputStats } from '../../application/board/get-throughput-stats.js';
import { getModelStats } from '../../application/board/get-model-stats.js';
import { getHarnessKpi } from '../../application/board/get-harness-kpi.js';
import { getCfdStats } from '../../application/board/get-cfd-stats.js';
import { createPrBadgeShared, type PrBadgeShared } from '../../application/board/pr-badge-shared.js';
import { createFixPushLookup, createFixPushWarmer } from '../../application/board/pr-fix-push-lookup.js';
import { readProjectRefs } from '../../application/board/read-cached-projects.js';
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
import type { ApiDeps } from './api-deps.js';

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

export function createStatsRoutes(
  deps: ApiDeps,
  prBadgeShared: PrBadgeShared = createPrBadgeShared(deps.prBadgeStatusCache),
): Hono {
  const app = new Hono();

  // bdboard-p5l.27: 修正 push 回数は /api/pr-links と同じ PR 情報キャッシュ・ゲートから
  // 引く。リクエストの中では **キャッシュを読むだけ** (gh も bd も起動しない) にして、
  // この重い集計のレイテンシを悪化させない。取れていない分は pending として返し、
  // バックグラウンドの先読み (single-flight) が埋める。gh / コメント読み取りの port が
  // 無い構成では先読みできないので、引き当て自体を付けず「不明 (確定)」として数える。
  const fixPush =
    deps.commentReader !== undefined && deps.prStatusReader !== undefined
      ? {
          lookup: createFixPushLookup(prBadgeShared),
          warm: createFixPushWarmer({
            cache: deps.cache,
            commentReader: deps.commentReader,
            prStatusReader: deps.prStatusReader,
            shared: prBadgeShared,
          }),
        }
      : undefined;

  app.get('/api/stats', async (c) => {
    const projectIds = parseProjectIds(c.req.query('projects'));
    const weeks = parseStatsWeeks(c.req.query('weeks'));
    const stats = await getThroughputStats(deps.cache, deps.now(), {
      ...(projectIds !== undefined ? { projectIds } : {}),
      weeks,
    });
    return c.json(toThroughputStatsDto(stats));
  });

  app.get('/api/model-stats', async (c) => {
    const projectIds = parseProjectIds(c.req.query('projects'));
    const weeks = parseStatsWeeks(c.req.query('weeks'));
    const stats = await getModelStats(deps.cache, deps.now(), {
      ...(projectIds !== undefined ? { projectIds } : {}),
      weeks,
      ...(fixPush !== undefined ? { fixPushLookup: fixPush.lookup } : {}),
    });
    // 取れていない修正 push 回数があるときだけ、応答を待たせずに裏で先読みを始める。
    // 先読みは失敗しても reject しない (createFixPushWarmer)。
    if (fixPush !== undefined && stats.complexityModel.fixPushPendingCount > 0) {
      void fixPush.warm(projectIds);
    }
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
      // bdboard-5lnh: scanGitLeftovers が要るのは project (rootPath 等) だけで、チケットは
      // 要らない。以前 (bdboard-4x55) は listProjectsChunked() で全チケットを読んでおり、
      // 直後の getHarnessKpi でも同じ listProjectsChunked() が走って2回読んでいた。
      // project だけを返す listProjectRefs() (listProjects() と同コストの射影。無い fake では
      // listProjects() にフォールバック) に寄せ、チケット側の読み出しは getHarnessKpi の
      // 1回だけにする。
      // 注意: これは yield しない同期呼び出し。パースキャッシュが温まっていれば約 0.2ms だが、
      // リフレッシュ直後 (無効化済みで onResult の再ウォームアップ前) は無効化された
      // プロジェクトをここで同期パースする (1.4万件のプロジェクトで約 33ms/件、最悪は全
      // プロジェクトが cold で約 640〜770ms)。/api/board の同期読み出しが一度払うのと
      // 同じコストを、ここも一度だけ払う。
      let scanProjects = readProjectRefs(deps.cache);
      if (projectIds !== undefined) {
        const filterSet = new Set(projectIds);
        scanProjects = scanProjects.filter((project) => filterSet.has(project.id));
      }
      const scan = await scanGitLeftovers(
        scanProjects,
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

    const stats = await getHarnessKpi(deps.cache, deps.now(), {
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

  app.get('/api/cfd', async (c) => {
    const projectIds = parseProjectIds(c.req.query('projects'));
    const days = parseCfdDays(c.req.query('days'));
    const stats = await getCfdStats(deps.cache, deps.now(), {
      ...(projectIds !== undefined ? { projectIds } : {}),
      days,
    });
    return c.json(toCfdStatsDto(stats));
  });

  return app;
}
