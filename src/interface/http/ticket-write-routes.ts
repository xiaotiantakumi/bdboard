import { Hono } from 'hono';
import { createTicketDecisionRoutes } from './ticket-decision-routes.js';
import { createTicketQuickActionRoutes } from './ticket-quick-action-routes.js';
import { createTicketDependencyWriteRoutes } from './ticket-dependency-write-routes.js';
import { createTicketContentRoutes } from './ticket-content-routes.js';
import { createTicketLabelWriteRoutes } from './ticket-label-write-routes.js';
import { createTicketSessionLinkWriteRoutes } from './ticket-session-link-write-routes.js';
import { createTicketCommentWriteRoutes } from './ticket-comment-write-routes.js';
import type { ApiDeps } from './routes.js';

// このファイルはチケット書き込み系のルートモジュールを元の登録順で束ねる合成レイヤ
// (bdboard-sso1.25)。旧 ticket-write-routes.ts (511行、12ルートが同居) をリソース別に
// 分割した際も、routes.ts 分割 (bdboard-sso1.1) と同じ理由で登録順序を保つ: Hono は
// 登録順でルート解決するため、他のグループ (ticket-read-routes.ts の
// GET /api/tickets/:id{.+} 等) との相対順序は routes.ts 側で保たれたまま、この
// ファイル内では旧ファイルの app.post/patch/delete の出現順そのまま:
// decision → quick-action(+undo) → dependencies → title/description → labels →
// session-link → comment、の順で各グループを app.route('/', ...) で載せる。
//
// ハンドラ本体・zod スキーマの記述は各グループのファイルへ一字一句そのまま移した
// (import/export の付け外しとインデント変化のみ)。findProjectRootPathForTicket /
// findCachedTicket / createRefreshAfterWrite は複数グループから使われるため
// ticket-write-shared.ts へ移した (routes.ts 分割の api-route-shared.ts と同じ方針)。

export function createTicketWriteRoutes(deps: ApiDeps): Hono {
  const app = new Hono();

  app.route('/', createTicketDecisionRoutes(deps));
  app.route('/', createTicketQuickActionRoutes(deps));
  app.route('/', createTicketDependencyWriteRoutes(deps));
  app.route('/', createTicketContentRoutes(deps));
  app.route('/', createTicketLabelWriteRoutes(deps));
  app.route('/', createTicketSessionLinkWriteRoutes(deps));
  app.route('/', createTicketCommentWriteRoutes(deps));

  return app;
}
