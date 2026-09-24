import { Hono } from 'hono';
import { z } from 'zod';
import { parseJsonBody } from './request-body.js';
import {
  getProjectHarnessStatus,
  resolveProjectContractState,
} from '../../application/harness/get-project-harness-status.js';
import { injectHarnessPack } from '../../application/harness/inject-harness-pack.js';
import type { HarnessRoutesDeps } from './harness-routes-deps.js';
import { extractProjectIdFromHarnessPath, toHarnessStatusJson } from './harness-routes-shared.js';

// harness-routes.ts (旧347行) の分割 (bdboard-sso1.56) で、
// POST /api/projects/*/harness/inject をここへ切り出した (move only, 挙動変更ゼロ)。

const injectBodySchema = z.object({
  pack: z.string().min(1).max(200),
});

export interface HarnessInjectRoutesParams {
  readonly now: () => Date;
}

export function createHarnessInjectRoutes(
  deps: HarnessRoutesDeps,
  { now }: HarnessInjectRoutesParams,
): Hono {
  const app = new Hono();

  app.post('/api/projects/*/harness/inject', async (c) => {
    const projectId = extractProjectIdFromHarnessPath(c.req.path);
    if (projectId === undefined) {
      return c.notFound();
    }

    const cached = deps.cache.getProject(projectId);
    if (cached === undefined) {
      return c.json({ error: 'project not found' }, 404);
    }

    const parsed = await parseJsonBody(c, injectBodySchema, {
      includeValidationDetails: true,
    });
    if (!parsed.ok) return parsed.response;

    const result = await injectHarnessPack(
      {
        registry: deps.registry,
        injector: deps.injector,
        now,
      },
      cached.project.rootPath,
      parsed.data.pack,
    );

    if (!result.ok) {
      if (result.failure.kind === 'pack-not-found') {
        return c.json({ error: 'pack not found' }, 404);
      }
      return c.json({ error: 'injection failed', detail: result.failure.detail }, 500);
    }

    // 注入は成功しているので、コントラクト評価の結果でレスポンスを止めない。
    // 「注入したがこのプロジェクトには検証ループが宣言されていない」を、注入直後に
    // その場で返すのがここの狙い (bdboard-pkr6.3)。
    const [contract, settingsJson] = await Promise.all([
      resolveProjectContractState(
        deps.contractReader,
        cached.project.rootPath,
        result.manifest,
        now(),
      ),
      deps.injector.readSettings(cached.project.rootPath),
    ]);
    const status = await getProjectHarnessStatus(
      deps.registry,
      result.manifest,
      contract,
      settingsJson,
    );
    return c.json(toHarnessStatusJson(status));
  });

  return app;
}
