/**
 * bdboard-4y8q.6.4 の受け入れ基準: 本物の下書きサービス + 一時ディレクトリの保存 + mountRoutes で、API の 5xx と処理されなかった例外を流す。
 * handler の throw が 500 の JSON (stack なし) になる / source に具体的な ID が入らない / 同じ失敗を 50 回起こしても receive は 1 回 /
 * respondBdError の 502 の detail が手元の情報に入る / 501・507・/api/issue-reports/* は報告されない / ヘッダーが付く /
 * BDBOARD_SELF_ERROR_DRAFTS=off ではヘッダーも付かない / 一度もキャッシュに載らないプロジェクトの名前とパスは伏せられる。
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createIssueDraftService } from '../application/issue-report/issue-draft-service.js';
import type { IssueDraftService } from '../application/issue-report/issue-draft-service.js';
import { BdError } from '../application/ports/issue-repository.js';
import { unrestrictedPlatformSupport } from '../domain/platform-support.js';
import type { Project } from '../domain/project.js';
import { createFsIssueDraftStorage } from '../infrastructure/fs/fs-issue-draft-storage.js';
import { respondBdError } from '../interface/http/bd-error-response.js';
import { ERROR_DRAFT_HEADER } from '../interface/http/server-error-capture.js';
import { mountRoutes } from './mount-routes.js';
import type { MountRoutesDeps } from './mount-routes.js';
import { wireSelfErrorReporter } from './wire-self-error-reporter.js';

const HOUR = 60 * 60_000;
const START = new Date('2026-10-06T00:00:00.000Z').getTime();
/** discovery には居るが、一度もキャッシュに載らない。 */
const UNCACHED: Project = { id: 'uncached', name: 'example-uncached', rootPath: '/private/example-uncached', aliasPaths: [], prefixes: [] };

const dirs: string[] = [];
beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(async () => {
  vi.resetAllMocks();
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function realService(): Promise<IssueDraftService> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bdboard-self-error-api-'));
  dirs.push(dir);
  let seq = 0;
  return createIssueDraftService({
    storage: createFsIssueDraftStorage(dir, { warn: () => undefined }),
    now: () => new Date(),
    newId: () => `${1791244800000 + seq++}-1234567890abcdef`,
  });
}

function inner(): Hono {
  return new Hono()
    .get('/api/tickets/:id{.+}', (c) => {
      throw new Error(`cannot read ticket ${c.req.param('id')}`);
    })
    .get('/api/board', (c) =>
      respondBdError(c, 'failed to read board', new BdError('unknown', 'uncached', 'cannot open /private/example-uncached: example-uncached is locked')),
    )
    .get('/api/comments-off', (c) => c.json({ error: 'comments not available' }, 501))
    .post('/api/issue-reports', (c) => c.json({ error: 'issue draft storage is full', code: 'storage-full' }, 507))
    .get('/api/issue-reports/drafts/:id', () => {
      throw new Error('intake failed');
    });
}

function mount(wired: ReturnType<typeof wireSelfErrorReporter>): Hono {
  const stub = (sentinel: string) => new Hono().get(sentinel, (c) => c.text('ok'));
  const deps: MountRoutesDeps = {
    security: { authMode: { kind: 'disabled-explicitly' } },
    platformSupport: unrestrictedPlatformSupport('darwin'),
    attachmentsRouter: stub('/__s/attachments'),
    inner: inner(),
    harnessRouter: stub('/__s/harness'),
    scanRootsRouter: stub('/__s/scan-roots'),
    boardThresholdsRouter: stub('/__s/board-thresholds'),
    hygieneThresholdsRouter: stub('/__s/hygiene-thresholds'),
    dbStatsRouter: stub('/__s/db-stats'),
    aiQuotaAlertRouter: stub('/__s/ai-quota-alert'),
    agentRunSettingsRouter: stub('/__s/agent-run-settings'),
    agentRunRouter: stub('/__s/agent-run'),
    tunnelRouter: stub('/__s/tunnel'),
    updateCheckRouter: stub('/__s/update-check'),
    issueReportsRouter: stub('/__s/issue-reports'),
    aiQuotaRouter: undefined,
    chatRouter: undefined,
    staticSpa: undefined,
    selfErrorReporter: wired.reporter,
  };
  const app = new Hono();
  mountRoutes(app, deps);
  return app;
}

async function setup(env: NodeJS.ProcessEnv = {}) {
  const real = await realService();
  const receive = vi.fn((input: Parameters<IssueDraftService['receive']>[0]) => real.receive(input));
  const clock = { at: START };
  const wired = wireSelfErrorReporter({
    env,
    service: { receive },
    cache: { listProjects: () => [], listProjectRefs: () => [] },
    applicationVersion: { getVersion: () => '1.2.3' },
    now: () => new Date(clock.at),
    log: () => undefined,
  });
  return { real, receive, clock, wired, app: mount(wired) };
}

describe('self error drafts from API failures (acceptance, real service, temp directory and mountRoutes)', () => {
  it('answers a handler throw with a 500 JSON and no stack, and keeps one draft for 50 identical failures', async () => {
    const { real, receive, app } = await setup();

    const first = await app.request('/api/tickets/bdboard-xyz9');
    expect(first.status).toBe(500);
    const text = await first.text();
    expect(JSON.parse(text)).toEqual({ error: 'internal error' });
    expect(text).not.toContain('cannot read ticket');
    expect(text).not.toContain('.ts');
    expect(first.headers.get(ERROR_DRAFT_HEADER)).toBe('recorded');

    for (let round = 0; round < 49; round += 1) {
      const again = await app.request('/api/tickets/bdboard-xyz9');
      expect(again.headers.get(ERROR_DRAFT_HEADER)).toBe('throttled');
    }
    expect(receive).toHaveBeenCalledTimes(1);

    const drafts = (await real.listWithPendingCount()).drafts;
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.title).toBe('[bdboard 本体] api:GET /api/tickets/:id{.+}');
    expect(drafts[0]?.source).toBe('api:GET /api/tickets/:id{.+}');
    expect(drafts[0]?.title).not.toContain('xyz9');
    expect(drafts[0]?.body).not.toContain('xyz9');
    expect(drafts[0]?.localOnly.errorTextRaw).toContain('cannot read ticket');
  });

  it('merges one more report an hour later, and a 502 from respondBdError keeps its detail in the local text', async () => {
    const { real, clock, app } = await setup();
    await app.request('/api/tickets/bdboard-xyz9');
    clock.at = START + HOUR;
    const later = await app.request('/api/tickets/bdboard-xyz9');
    expect(later.headers.get(ERROR_DRAFT_HEADER)).toBe('recorded');
    expect((await real.listWithPendingCount()).drafts[0]?.occurrenceCount).toBe(2);

    const bd = await app.request('/api/board');
    expect(bd.status).toBe(502);
    expect(await bd.json()).toEqual({ error: 'failed to read board', detail: 'cannot open /private/example-uncached: example-uncached is locked' });
    const board = (await real.listWithPendingCount()).drafts.find((draft) => draft.source === 'api:GET /api/board');
    expect(board?.localOnly.errorTextRaw).toContain('error: failed to read board');
    expect(board?.localOnly.errorTextRaw).toContain('detail: cannot open');
  });

  it('masks the name and path of a project that never reached the cache once a refresh has told the reporter about it', async () => {
    const { real, wired, app } = await setup();
    wired.onRefreshResult?.({ refreshed: [], reused: [], removed: [], errors: [] }, [UNCACHED]);
    // onRefreshResult は待たない約束。次の要求の前に observeRefresh の同期の部分 (一覧を覚える) は済んでいる。
    await app.request('/api/board');
    const board = (await real.listWithPendingCount()).drafts.find((draft) => draft.source === 'api:GET /api/board');
    expect(board?.localOnly.errorTextRaw).toContain('detail: cannot open <project-root>: <project> is locked');
    expect(board?.localOnly.errorTextRaw).not.toContain('example-uncached');
  });

  it('does not report 501, 507 and anything under /api/issue-reports (the header says skipped)', async () => {
    const { real, receive, app } = await setup();
    const unsupported = await app.request('/api/comments-off');
    const full = await app.request('/api/issue-reports', { method: 'POST' });
    const intake = await app.request('/api/issue-reports/drafts/abc');
    expect(unsupported.status).toBe(501);
    expect(full.status).toBe(507);
    expect(intake.status).toBe(500);
    for (const res of [unsupported, full, intake]) expect(res.headers.get(ERROR_DRAFT_HEADER)).toBe('skipped');
    expect(receive).not.toHaveBeenCalled();
    expect((await real.listWithPendingCount()).drafts).toHaveLength(0);
  });

  it.each(['off', '0', 'false'])('with BDBOARD_SELF_ERROR_DRAFTS=%s nothing is captured and no header is added (the 500 JSON stays)', async (value) => {
    const { real, receive, wired, app } = await setup({ BDBOARD_SELF_ERROR_DRAFTS: value });
    expect(wired.reporter).toBeUndefined();
    const res = await app.request('/api/tickets/bdboard-xyz9');
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'internal error' });
    expect(res.headers.get(ERROR_DRAFT_HEADER)).toBeNull();
    const bd = await app.request('/api/board');
    expect(bd.headers.get(ERROR_DRAFT_HEADER)).toBeNull();
    expect(receive).not.toHaveBeenCalled();
    expect((await real.listWithPendingCount()).drafts).toHaveLength(0);
  });
});
