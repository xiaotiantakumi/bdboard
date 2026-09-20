/**
 * bdboard-sso1.14: src/main.ts (composition root) からリリース更新通知領域の
 * 配線を切り出したもの (move only, 挙動変更ゼロ)。
 *
 * bdboard はローカル完結のツールなので、外部への通信が増えるのは性質の変化に
 * あたる (bdboard-70z.7)。既定は有効だが BDBOARD_UPDATE_CHECK_DISABLED=1 で
 * 完全に無効化でき、無効時は createUpdateCheckService がネットワークへ一切
 * 出ない (ルート自体は残り、常に state=unknown を返す — UI 側はそれを
 * 「黙る」として扱う)。
 */
import type { Hono } from 'hono';
import type { ApplicationVersionProvider } from '../application/ports/application-version.js';
import { createUpdateCheckService } from '../application/update/get-update-check.js';
import { createGithubReleaseSource } from '../infrastructure/index.js';
import { createUpdateCheckRoutes } from '../interface/http/update-check-routes.js';
import { envBool, envInt, envString } from '../infrastructure/env.js';

export interface WireUpdateCheckDeps {
  readonly env: NodeJS.ProcessEnv;
  readonly applicationVersion: ApplicationVersionProvider;
}

export function wireUpdateCheck(deps: WireUpdateCheckDeps): { updateCheckRouter: Hono } {
  const updateCheckEnabled = !envBool(deps.env, 'BDBOARD_UPDATE_CHECK_DISABLED');
  const updateCheckService = createUpdateCheckService({
    applicationVersion: deps.applicationVersion,
    source: createGithubReleaseSource({
      repository: envString(deps.env, 'BDBOARD_UPDATE_CHECK_REPO', 'xiaotiantakumi/bdboard'),
      timeoutMs: envInt(deps.env, 'BDBOARD_UPDATE_CHECK_TIMEOUT_MS', 3_000),
      userAgent: deps.applicationVersion.getVersion(),
    }),
    now: () => new Date(),
    ttlMs: envInt(deps.env, 'BDBOARD_UPDATE_CHECK_CACHE_MS', 6 * 60 * 60_000),
    enabled: updateCheckEnabled,
  });
  return { updateCheckRouter: createUpdateCheckRoutes({ updateCheckService }) };
}
