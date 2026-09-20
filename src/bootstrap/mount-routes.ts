/**
 * bdboard-sso1.14: src/main.ts (composition root) からルートの mount 順だけを
 * 切り出したもの (move only, 挙動変更ゼロ)。
 *
 * 各ルーター (Hono サブアプリ) は main.ts 側の wire-*.ts が組み立てて渡す —
 * このファイルは「何をどの順で mount するか」だけを持ち、依存の組み立ては
 * 一切行わない。Hono はルートを登録順に解決するため、この順序が変わると
 * `GET /api/tickets/:id{.+}` のような catch-all が具体ルートより先に呼ばれて
 * しまう (bdboard-qw26 / PR #514 の事故と同種)。分割前の main.ts での
 * 登録順は `mount-routes.test.ts` の EXPECTED_MOUNT_ORDER としてロックダウンして
 * ある。
 */
import type { Hono } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import {
  createPlatformFeatureGuard,
  createPlatformSupportRoutes,
} from '../interface/http/platform-support-routes.js';
import type { PlatformSupport } from '../domain/platform-support.js';
import {
  mountSecurityMiddleware,
  type SecurityMountDeps,
} from '../interface/http/app-security.js';
import { createCompressionMiddleware } from '../interface/http/compression.js';

export interface StaticSpaDeps {
  readonly webDistDir: string;
  readonly spaIndexHtml: string;
}

export interface MountRoutesDeps {
  readonly security: SecurityMountDeps;
  readonly platformSupport: PlatformSupport;
  /** チケット添付画像 (bdboard-qw26)。`inner` の catch-all より前に mount する。 */
  readonly attachmentsRouter: Hono;
  /** src/interface/http/routes.ts (bdboard-sso1.1 で分割済み)。 */
  readonly inner: Hono;
  readonly harnessRouter: Hono;
  readonly scanRootsRouter: Hono;
  readonly boardThresholdsRouter: Hono;
  readonly hygieneThresholdsRouter: Hono;
  readonly dbStatsRouter: Hono;
  readonly aiQuotaAlertRouter: Hono;
  readonly agentRunSettingsRouter: Hono;
  readonly agentRunRouter: Hono;
  readonly tunnelRouter: Hono;
  readonly updateCheckRouter: Hono;
  /** BDBOARD_AI_QUOTA_DISABLED のとき未登録 (undefined)。 */
  readonly aiQuotaRouter: Hono | undefined;
  /** BDBOARD_CHAT_DISABLED のとき未登録 (undefined)。 */
  readonly chatRouter: Hono | undefined;
  /** web/dist が存在しない (API only) 場合は undefined。 */
  readonly staticSpa: StaticSpaDeps | undefined;
}

/**
 * main.ts の `const app = new Hono()` 以降のルート mount 一式を、分割前と
 * 全く同じ順序で登録する。
 */
export function mountRoutes(app: Hono, deps: MountRoutesDeps): void {
  mountSecurityMiddleware(app, deps.security);
  app.use('*', createCompressionMiddleware());

  // 未対応機能は inner へ届く前に 501 で止める (bdboard-70z.9)。
  app.route('/', createPlatformSupportRoutes({ platformSupport: deps.platformSupport }));
  // コレクションとワイルドカードの両方を登録する (chat-routes.ts の既存の作法)。
  for (const pattern of ['/api/processes', '/api/processes/*']) {
    app.use(pattern, createPlatformFeatureGuard(deps.platformSupport, 'session-discovery'));
  }
  app.use('/api/chat/*', createPlatformFeatureGuard(deps.platformSupport, 'chat'));

  // `inner` (routes.ts) の `GET /api/tickets/:id{.+}` は catch-all なので、
  // attachment routes は必ず inner より前に mount する (bdboard-qw26)。
  app.route('/', deps.attachmentsRouter);
  app.route('/', deps.inner);

  app.route('/', deps.harnessRouter);
  app.route('/', deps.scanRootsRouter);
  app.route('/', deps.boardThresholdsRouter);
  app.route('/', deps.hygieneThresholdsRouter);
  app.route('/', deps.dbStatsRouter);
  app.route('/', deps.aiQuotaAlertRouter);
  app.route('/', deps.agentRunSettingsRouter);
  app.route('/', deps.agentRunRouter);
  app.route('/', deps.tunnelRouter);
  app.route('/', deps.updateCheckRouter);

  if (deps.aiQuotaRouter !== undefined) {
    app.route('/', deps.aiQuotaRouter);
  }

  if (deps.chatRouter !== undefined) {
    app.route('/', deps.chatRouter);
  }

  if (deps.staticSpa !== undefined) {
    // root には絶対パスを渡す (bdboard-gki の経緯は main.ts 側の wire-static-spa
    // コメントを参照)。
    app.use('/*', serveStatic({ root: deps.staticSpa.webDistDir }));
    app.get('*', (c) => {
      if (c.req.path.startsWith('/api/') || c.req.path === '/api') {
        return c.notFound();
      }
      return c.html(deps.staticSpa!.spaIndexHtml);
    });
  }
}
