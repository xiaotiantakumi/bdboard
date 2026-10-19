import { Hono } from 'hono';
import { z } from 'zod';
import { parseJsonBody } from './request-body.js';
import { getBoardTimeZoneOverride } from '../../config/board-timezone.js';
import type { ApiDeps } from './api-deps.js';

const visibleProjectsBodySchema = z.object({
  clientId: z.string().min(1).max(128),
  projectIds: z.array(z.string().min(1).max(4096)).max(1000),
});

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
    const visible = deps.visibleProjects;
    const errors =
      visible !== undefined && visible.hasReports()
        ? status.errors.filter((error) => visible.isVisible(error.projectId))
        : status.errors;
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
  app.put('/api/ui/visible-projects', async (c) => {
    const registry = deps.visibleProjects;
    if (registry === undefined) {
      return c.json({ error: 'visible projects registry unavailable' }, 404);
    }
    const parsed = await parseJsonBody(c, visibleProjectsBodySchema);
    if (!parsed.ok) return parsed.response;
    const added = registry.report(parsed.data.clientId, parsed.data.projectIds);
    // 新しく表示された、いま読み取りエラー中のプロジェクトだけ再読み込みして、
    // (表示中になったので許可される) dolt start → 再試行を次の定期更新まで待たせない。
    const failing = new Set(deps.getStatus().errors.map((e) => e.projectId));
    for (const projectId of added) {
      if (failing.has(projectId) && deps.refreshProjectByRootPath !== undefined) {
        void deps.refreshProjectByRootPath(projectId).catch(() => undefined);
      }
    }
    return c.json({ ok: true });
  });

  return app;
}
