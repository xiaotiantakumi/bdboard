import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import {
  findPlatformLimitation,
  type PlatformFeature,
  type PlatformSupport,
} from '../../domain/platform-support.js';

export interface PlatformSupportRoutesDeps {
  readonly platformSupport: PlatformSupport;
}

/**
 * 実行プラットフォームで使えない機能を UI に伝える (bdboard-70z.9)。
 * 認証や書き込みを伴わない静的な情報なので、キャッシュも SSE も要らない。
 */
export function createPlatformSupportRoutes(deps: PlatformSupportRoutesDeps): Hono {
  const app = new Hono();

  app.get('/api/platform-support', (c) => {
    return c.json({
      platform: deps.platformSupport.platform,
      limitations: deps.platformSupport.limitations.map((limitation) => ({
        feature: limitation.feature,
        reason: limitation.reason,
        detail: limitation.detail,
      })),
    });
  });

  return app;
}

/**
 * 未対応機能のエンドポイントを 501 で止める (bdboard-70z.9)。
 *
 * 素通しすると ps/lsof や .cmd シムが無いことに由来する例外がそのまま 500 に
 * なり、「壊れている」のか「そもそも動かない」のか区別が付かない。501 と
 * 理由を返して、未対応であることが分かる形で落とす。
 */
export function createPlatformFeatureGuard(
  platformSupport: PlatformSupport,
  feature: PlatformFeature,
): MiddlewareHandler {
  const limitation = findPlatformLimitation(platformSupport, feature);

  return async (c, next) => {
    if (limitation === null) {
      await next();
      return;
    }

    return c.json(
      {
        error: 'platform-unsupported',
        feature: limitation.feature,
        platform: platformSupport.platform,
        reason: limitation.reason,
        detail: limitation.detail,
      },
      501,
    );
  };
}
