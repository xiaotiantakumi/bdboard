import { Hono } from 'hono';
import { createWriteGuardMiddleware } from './write-guard.js';
import type { HarnessRoutesDeps } from './harness-routes-deps.js';
import { createHarnessStatusRoutes } from './harness-status-routes.js';
import { createHarnessInjectRoutes } from './harness-inject-routes.js';
import { createHarnessContractTicketRoutes } from './harness-contract-ticket-routes.js';

// bdboard-sso1.56: harness-routes.ts (旧347行) を、関心別のルート登録モジュール
// (harness-status-routes.ts / harness-inject-routes.ts /
// harness-contract-ticket-routes.ts) と共有ヘルパー (harness-routes-shared.ts) へ
// 分割した (move only, 挙動変更ゼロ)。このファイルは合成層として残り、公開 API
// (createHarnessRoutes・HarnessRoutesDeps) は分割前と同一。トップレベルの
// ミドルウェア (write guard) はどのグループを跨いでも適用順が変わってはいけないため、
// ここに残したまま各グループのルート登録より先に呼ぶ (元のファイルでの並び:
// ミドルウェア1件 → ルート5件、をそのまま維持。agent-run-routes.ts 分割
// bdboard-sso1.27 / chat-routes.ts 分割 bdboard-sso1.17 と同じ方針)。

// bdboard-tml8: HarnessRoutesDeps の実体は harness-routes-deps.ts (このファイルとの
// 型だけの import 循環を dependency-cruiser no-circular が検出したため抽出)。外部
// から従来どおり harness-routes.ts 経由でも参照できるよう再輸出する。
export type { HarnessRoutesDeps } from './harness-routes-deps.js';

export function createHarnessRoutes(deps: HarnessRoutesDeps): Hono {
  const app = new Hono();
  const now = deps.now ?? (() => new Date());

  app.use('*', createWriteGuardMiddleware(deps.writeAccess ?? {}));

  app.route('/', createHarnessStatusRoutes(deps, { now }));
  app.route('/', createHarnessInjectRoutes(deps, { now }));
  app.route('/', createHarnessContractTicketRoutes(deps, { now }));

  return app;
}
