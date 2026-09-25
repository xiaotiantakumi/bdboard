import { describe, expect, it } from 'vitest';
import { createApiRoutes } from '../interface/http/routes.js';
import { makeTicket } from '../domain/test-support.js';
import { createSqliteBoardCache } from '../infrastructure/cache/sqlite-board-cache.js';
import { NOW, project, createDeps } from '../interface/http/routes-test-support.js';

// bdboard-mkkx: bdboard-ve1y's stats-routes.test.ts has a test proving the
// *aggregation loops* (getThroughputStats/getModelStats) yield to the event
// loop, but it uses the in-memory fake cache, whose listProjects() is a
// plain array read - free. It can't exercise the cost this ticket is about:
// the real SqliteBoardCache's listProjects() (SQLite row read + JSON.parse
// of every project's tickets), which both stats handlers call *before* the
// now-chunked aggregation even starts, and which was still one
// uninterrupted synchronous block (measured at 590-613ms for 200,000
// tickets - long enough to starve /api/health on its own even with the
// aggregation fix in place). This test uses the real createSqliteBoardCache()
// so listProjectsChunked() (the fix) is actually exercised, not bypassed by
// a fake.
//
// This lives under src/bootstrap/ rather than next to stats-routes.test.ts
// in src/interface/http/: the interface-no-infrastructure dependency-cruiser
// rule (check:boundaries) forbids src/interface/** from importing
// src/infrastructure/** directly, and this test needs both the real HTTP
// routes (interface) and the real SQLite cache (infrastructure). bootstrap
// is the composition root and is unconstrained as an import source (see
// .dependency-cruiser.cjs's no-upstream-deps-on-bootstrap comment), so it's
// the layer-correct place for a test that wires both together.
describe('createApiRoutes + createSqliteBoardCache (bdboard-mkkx)', () => {
  // Spread across 200 projects rather than one giant project: chunking here
  // happens at *project* granularity (a project row's tickets are parsed in
  // one synchronous JSON.parse that can't be interrupted mid-call - see the
  // comment on listProjectsChunked() in
  // src/infrastructure/cache/sqlite-board-cache/read.ts), so the size of a
  // single project bounds the longest possible gap between yields. 200
  // projects keeps each project's share small (1,000 tickets) enough that
  // /api/health reliably gets a turn well under the 1s budget; concentrating
  // all 200,000 tickets in a handful of projects (as this app's real project
  // count of ~14 would, if scaled up literally) defeats the per-project
  // chunking this fix relies on.
  //
  // Three assertions below, all against the same measured run:
  // - `<1000ms` is the ticket's literal acceptance criterion.
  // - `order[0] === 'health'` (requested last, must finish first) is
  //   necessary but NOT sufficient alone: bdboard-uy10 found that forcing
  //   the pre-fix sync listProjects() fallback still resolves 'health'
  //   first every time (only its *magnitude* changes, not its position).
  // - the ratio assertion right below `order[0]` is the actual regression
  //   guard, and is what bdboard-uy10 changed. It used to be a fixed
  //   `health.elapsedMs < 400`: bdboard-mkkx's PR #680 review found that
  //   forcing the fallback only pushed health.elapsedMs to ~630-940ms on
  //   that reviewer's machine (under the 1000ms budget above on its own,
  //   so that assertion alone wouldn't have caught a revert), while the
  //   fixed path measured ~15-45ms there - 400ms seemed to leave headroom
  //   in both directions. That constant then broke main's landed-verify
  //   (bdboard-uy10, 2026-09-25): under real multi-session contention (load
  //   average 13-15, no artificial load) the *fixed* path itself measured
  //   532ms on a shared box. The fix was intact; the absolute-ms margin
  //   measured under synthetic single-machine contention just didn't hold
  //   under real contention, which slows the whole process - fixed and
  //   reverted alike - by an amount unrelated to whether the fix is
  //   present.
  //
  //   Replaced with a comparison relative to this run's own slow calls
  //   instead of a wall-clock constant, so it scales with the machine's
  //   load instead of assuming a fixed number is comparable across runs:
  //   health must finish in under half the wall time the slower of
  //   stats/model-stats took (the two finish within ~1ms of each other -
  //   both walk the same yield-gate cadence in lockstep, see
  //   listProjectsChunked()). Measured on this development machine (load
  //   average ~12-16 from unrelated concurrent sessions, no artificial
  //   load): 21 fixed-path runs kept health.elapsedMs at 6-13% of the
  //   slower call's time (health 74-179ms vs. stats/model-stats
  //   881-2251ms); forcing the fallback (mutation check, 9 runs) pushed
  //   that ratio to 74-81% (and past the literal 1000ms budget: health
  //   1423-1937ms). 50% leaves wide margin on both sides. Keep the
  //   `<1000ms` line too - it's a useful backstop for a heavy-load stall
  //   landing inside health's own window, which can trip it before the
  //   ratio does. If this fixture's ticket/project counts ever change,
  //   re-measure rather than assuming 50% still holds: health's fixed-path
  //   time is mostly a fixed one-off (router setup, first project parse),
  //   so a much smaller fixture would shrink the *gap* faster than that
  //   overhead, pushing the fixed-path ratio toward the cutoff.
  it(
    'does not block /api/health while reading a large real-SQLite project cache',
    async () => {
      const cache = createSqliteBoardCache(':memory:');
      const closedAt = new Date('2026-06-01T10:00:00.000Z');
      const PROJECT_COUNT = 200;
      const TOTAL_TICKETS = 200_000;
      const baseCount = Math.floor(TOTAL_TICKETS / PROJECT_COUNT);
      let ticketsSoFar = 0;
      for (let projectIndex = 0; projectIndex < PROJECT_COUNT; projectIndex += 1) {
        const proj = project(`big-${projectIndex}`, `/projects/big-${projectIndex}`);
        // Spread the remainder across the first few projects so the total is
        // exactly TOTAL_TICKETS, mirroring real boards where project sizes vary.
        const count =
          projectIndex === PROJECT_COUNT - 1 ? TOTAL_TICKETS - ticketsSoFar : baseCount;
        ticketsSoFar += count;
        const tickets = Array.from({ length: count }, (_, index) =>
          makeTicket({
            id: `bdboard-big-${projectIndex}-${index}`,
            projectId: proj.id,
            createdAt: closedAt,
            closedAt: index % 2 === 0 ? closedAt : undefined,
            models:
              index % 3 === 0
                ? [{ stage: 'implement', model: 'model-a' }]
                : undefined,
          }),
        );
        cache.putProject({
          project: proj,
          tickets,
          fingerprint: `fp-big-${projectIndex}`,
          fetchedAt: NOW,
        });
      }

      const app = createApiRoutes(createDeps({ cache }));

      const order: string[] = [];
      const statsStartedAt = Date.now();
      const statsPromise = (async () => {
        const response = await app.request('/api/stats?weeks=26');
        order.push('stats');
        return { response, elapsedMs: Date.now() - statsStartedAt };
      })();
      const modelStatsPromise = (async () => {
        const response = await app.request('/api/model-stats?weeks=26');
        order.push('model-stats');
        return { response, elapsedMs: Date.now() - statsStartedAt };
      })();
      const healthPromise = (async () => {
        // bdboard-ve1y (see stats-routes.test.ts): wait for our own
        // setImmediate tick before issuing the request. Without this, a
        // regression where the fix degrades to a microtask-only "yield"
        // could still let this assertion pass by accident.
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        const response = await app.request('/api/health');
        order.push('health');
        return { response, elapsedMs: Date.now() - statsStartedAt };
      })();

      const [stats, modelStats, health] = await Promise.all([
        statsPromise,
        modelStatsPromise,
        healthPromise,
      ]);

      expect(stats.response.status).toBe(200);
      expect(modelStats.response.status).toBe(200);
      expect(health.response.status).toBe(200);
      // Requested last, but must finish first.
      expect(order[0]).toBe('health');

      // bdboard-uy10: both timing assertions below carry the raw
      // measurements in their failure message, so a landed-verify failure
      // can be triaged at a glance - a high health/slowestStatsMs ratio
      // means the fix likely regressed; a low ratio with only the <1000ms
      // line failing points at a heavy-load stall instead (see comment
      // above).
      const slowestStatsMs = Math.max(stats.elapsedMs, modelStats.elapsedMs);
      const timingSummary = `health=${health.elapsedMs}ms stats=${stats.elapsedMs}ms modelStats=${modelStats.elapsedMs}ms ratio=${(health.elapsedMs / slowestStatsMs).toFixed(2)}`;
      expect(health.elapsedMs, timingSummary).toBeLessThan(1000); // ticket's literal acceptance criterion
      expect(health.elapsedMs, timingSummary).toBeLessThan(slowestStatsMs * 0.5); // regression guard, relative not absolute

      cache.close();
    },
    30_000,
  );
});
