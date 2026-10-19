import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { readProjectRefs } from '../../application/board/read-cached-projects.js';
import { parseJsonBody } from './request-body.js';
import { getBoardTimeZoneOverride } from '../../config/board-timezone.js';
import type { ApiDeps } from './api-deps.js';

const clientIdSchema = z.string().min(1).max(128);
const visibleProjectsBodySchema = z.union([
  // 選択が空 = 全プロジェクト表示 (ワイルドカード)。
  z.object({ clientId: clientIdSchema, all: z.literal(true) }),
  z.object({
    clientId: clientIdSchema,
    projectIds: z.array(z.string().min(1).max(4096)).max(1000),
  }),
]);
const VISIBLE_PROJECTS_BODY_MAX_BYTES = 256 * 1024;

export function createHealthStatusRoutes(deps: ApiDeps): Hono {
  const app = new Hono();
  const applicationVersion = deps.applicationVersion.getVersion();

  app.get('/api/health', (c) => {
    return c.json({
      ok: true,
      now: deps.now().toISOString(),
      version: applicationVersion,
      ...(deps.instanceNonce !== undefined ? { instanceNonce: deps.instanceNonce } : {}),
    });
  });

  app.get('/api/status', (c) => {
    const status = deps.getStatus();
    // bdboard-o1e5: 表示中プロジェクトの申告が1件でもあれば、そのプロジェクト分のエラーだけ出す。
    // 申告が無い (未起動・全タブ TTL 切れ・申告できない遠隔のみ) ときは従来どおり全件。
    // 絞り込めるのはキャッシュにあるプロジェクトのエラーだけ。キャッシュに無い projectId
    // (初回起動で読めなかった等) のエラーは、表示中かどうか分からないので必ず出す。
    const visible = deps.visibleProjects?.snapshot();
    let errors = status.errors;
    if (visible !== undefined && visible.hasReports && status.errors.length > 0) {
      const cachedIds = new Set(readProjectRefs(deps.cache).map((p) => p.id));
      errors = status.errors.filter(
        (error) => !cachedIds.has(error.projectId) || visible.isVisible(error.projectId),
      );
    }
    return c.json({
      lastRefreshAt:
        status.lastRefreshAt !== null
          ? status.lastRefreshAt.toISOString()
          : null,
      errors: errors.map((error) => ({
        kind: error.kind,
        projectId: error.projectId,
        detail: error.detail,
      })),
      projectCount: status.projectCount,
      boardTimeZone: getBoardTimeZoneOverride() ?? null,
    });
  });

  // bdboard-o1e5: クライアントが「いま画面に出しているプロジェクト」を申告する。UI 状態の
  // 申告だがインメモリのみ・データ非変更。他の PUT と同じく routes.ts の書き込みガード
  // (ローカル直アクセスのみ。トンネル書き込み未開放なら 403) の内側に入る。
  app.put(
    '/api/ui/visible-projects',
    bodyLimit({
      maxSize: VISIBLE_PROJECTS_BODY_MAX_BYTES,
      onError: (c) => c.json({ error: 'request body too large' }, 413),
    }),
    async (c) => {
      const registry = deps.visibleProjects;
      if (registry === undefined) {
        return c.json({ error: 'visible projects registry unavailable' }, 404);
      }
      const parsed = await parseJsonBody(c, visibleProjectsBodySchema);
      if (!parsed.ok) return parsed.response;
      const before = registry.snapshot();
      registry.report(
        parsed.data.clientId,
        'all' in parsed.data ? { all: true } : { projectIds: parsed.data.projectIds },
      );
      const after = registry.snapshot();
      // 新しく表示中になった、いま読み取りエラー中のプロジェクトをまとめて 1 回だけ再読み込みし、
      // (表示中になったので許可される) dolt start → 再試行を次の定期更新まで待たせない。
      const newlyVisibleFailing = [
        ...new Set(
          deps
            .getStatus()
            .errors.map((e) => e.projectId)
            .filter((id) => !before.isVisible(id) && after.isVisible(id)),
        ),
      ];
      if (newlyVisibleFailing.length > 0 && deps.refreshProjects !== undefined) {
        void deps.refreshProjects(newlyVisibleFailing).catch(() => undefined);
      }
      return c.json({ ok: true });
    },
  );

  return app;
}
