import { Hono } from 'hono';
import { parseClampedIntQueryParam } from './parse-clamped-int-query-param.js';
import { getActivityFeed } from '../../application/board/get-activity-feed.js';
import { getBoard } from '../../application/board/get-board.js';
import { searchTickets } from '../../application/board/search-tickets.js';
import { DEFAULT_LIVENESS_THRESHOLDS } from '../../domain/liveness.js';
import { compareStrings } from '../../domain/compare.js';
import {
  countIncompleteTicketsFromTickets,
  toActivityEventDto,
  toBoardViewDto,
  toProjectDto,
  toTicketSearchResultDto,
  type ProjectDto,
} from './dto.js';
import {
  boardViewDtoStableJson,
  computeWeakEtag,
  ifNoneMatchMatches,
} from './etag.js';
import {
  buildGetBoardDeps,
  parseActivityLimit,
  parseProjectIds,
  resolveLivenessThresholds,
} from './api-route-shared.js';
import { groupSessionsByProject } from '../../application/session/link-sessions-to-projects.js';
import type { ApiDeps } from './routes.js';

const SEARCH_DEFAULT_LIMIT = 30;
const SEARCH_MIN_LIMIT = 1;
const SEARCH_MAX_LIMIT = 50;

const ACTIVITY_DEFAULT_DAYS = 1;
const ACTIVITY_MIN_DAYS = 1;
const ACTIVITY_MAX_DAYS = 30;

// closed(done)レーンの既定上限。単調増加するdoneチケットが/api/boardペイロードを
// 支配しないよう、プロジェクトごとにclosedAt降順で上位N件だけを送る(bdboard-3tw.86)。
const BOARD_DEFAULT_CLOSED_LIMIT = 100;
const BOARD_MIN_CLOSED_LIMIT = 1;
const BOARD_MAX_CLOSED_LIMIT = 1000;

function parseSearchLimit(raw: string | undefined): number {
  return parseClampedIntQueryParam(raw, {
    min: SEARCH_MIN_LIMIT,
    max: SEARCH_MAX_LIMIT,
    defaultValue: SEARCH_DEFAULT_LIMIT,
  });
}

function parseActivityDays(raw: string | undefined): number {
  return parseClampedIntQueryParam(raw, {
    min: ACTIVITY_MIN_DAYS,
    max: ACTIVITY_MAX_DAYS,
    defaultValue: ACTIVITY_DEFAULT_DAYS,
  });
}

function parseClosedLimit(raw: string | undefined): number {
  return parseClampedIntQueryParam(raw, {
    min: BOARD_MIN_CLOSED_LIMIT,
    max: BOARD_MAX_CLOSED_LIMIT,
    defaultValue: BOARD_DEFAULT_CLOSED_LIMIT,
  });
}

export function createBoardRoutes(deps: ApiDeps): Hono {
  const app = new Hono();

  app.get('/api/projects', async (c) => {
    const now = deps.now();
    // ユーザー設定の liveness 閾値を反映する (bdboard-3tw.102.5)。渡さないと
    // activeSessionCount = ヘッダーの「稼働中 N」だけが既定値のままになる。
    const livenessThresholds = await resolveLivenessThresholds(deps);
    const cachedProjects = deps.cache
      .listProjects()
      // Locale-independent, to match cache.listProjects()/getBoard ordering.
      .slice()
      .sort((a, b) => compareStrings(a.project.rootPath, b.project.rootPath));
    const allProjects = cachedProjects.map((entry) => entry.project);
    const sessionsByProject = groupSessionsByProject(
      deps.sessions?.() ?? [],
      allProjects,
    );

    const projects: ProjectDto[] = cachedProjects.map((entry) =>
      toProjectDto(entry.project, now, livenessThresholds, {
        sessions: sessionsByProject.get(entry.project.id),
        incompleteTicketCount: countIncompleteTicketsFromTickets(entry.tickets),
      }),
    );

    return c.json(projects);
  });

  app.get('/api/board', async (c) => {
    const projectIds = parseProjectIds(c.req.query('projects'));
    const epicId = c.req.query('epicId');
    const viewRaw = c.req.query('view') ?? 'merged';
    const closedLimit = parseClosedLimit(c.req.query('closedLimit'));

    if (viewRaw !== 'merged' && viewRaw !== 'split') {
      return c.json(
        { error: 'invalid view', allowed: ['merged', 'split'] },
        400,
      );
    }

    const boardDeps = await buildGetBoardDeps(deps);
    const view = await getBoard(
      boardDeps,
      {
        ...(projectIds !== undefined ? { projectIds } : {}),
        ...(epicId !== undefined && epicId.length > 0 ? { epicId } : {}),
        mode: viewRaw,
        closedLimit,
      },
    );

    const sessionsByProject = groupSessionsByProject(
      deps.sessions?.() ?? [],
      view.projects.map((entry) => entry.project),
    );

    /*
     * ここは意図的に resolveLivenessThresholds を使わない (bdboard-5kz2)。
     * buildGetBoardDeps が既に getBoardThresholds を1回引いており、その同じ値を
     * getBoard (card.liveness をドメインで計算) とこの DTO 変換
     * (sessions[].liveness) の両方が使うことで、1リクエスト内の2つの liveness が
     * 必ず同じ閾値から出ることを保証している。ここで resolveLivenessThresholds を
     * 呼ぶと getBoardThresholds を2回引くことになり、その間に設定が変わると
     * バッジとセッション行が食い違う — bdboard-3tw.102.5 で潰したのと同じ不整合。
     * 上の resolveLivenessThresholds のコメントに従ってここを「整理」しないこと。
     * テストは getBoardThresholds に定数を注入するので、2回引きは緑のまま通る。
     */
    const dto = toBoardViewDto(
      view,
      boardDeps.livenessThresholds ?? DEFAULT_LIVENESS_THRESHOLDS,
      sessionsByProject,
    );
    const etag = computeWeakEtag(boardViewDtoStableJson(dto));

    c.header('ETag', etag);
    c.header('Cache-Control', 'no-cache');
    c.header('Vary', 'Accept-Encoding');

    const ifNoneMatch = c.req.header('If-None-Match');
    if (
      ifNoneMatch !== undefined &&
      ifNoneMatchMatches(ifNoneMatch, etag)
    ) {
      return c.body(null, 304);
    }

    return c.json(dto);
  });

  app.get('/api/search', (c) => {
    const query = c.req.query('q') ?? '';
    const limit = parseSearchLimit(c.req.query('limit'));

    const hits = searchTickets(deps.cache, { query, limit });
    return c.json(hits.map(toTicketSearchResultDto));
  });

  app.get('/api/activity', (c) => {
    const projectIds = parseProjectIds(c.req.query('projects'));
    const days = parseActivityDays(c.req.query('days'));
    const limit = parseActivityLimit(c.req.query('limit'));

    const events = getActivityFeed(deps.cache, deps.now(), {
      ...(projectIds !== undefined ? { projectIds } : {}),
      windowDays: days,
      limit,
    });

    return c.json(events.map(toActivityEventDto));
  });

  return app;
}
