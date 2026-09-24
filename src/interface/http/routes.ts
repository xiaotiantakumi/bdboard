import { Hono } from 'hono';
import { createWriteGuardMiddleware } from './write-guard.js';
import { createInFlightOverlapMemo } from './api-route-shared.js';
import type { ApiDeps } from './api-deps.js';
import { createHealthStatusRoutes } from './health-status-routes.js';
import { createBoardRoutes } from './board-routes.js';
import { createStatsRoutes } from './stats-routes.js';
import { createHygieneRoutes } from './hygiene-routes.js';
import { createTicketReadRoutes } from './ticket-read-routes.js';
import { createTicketWriteRoutes } from './ticket-write-routes.js';
import { createCommentRoutes } from './comment-routes.js';
import { createSessionProcessRoutes } from './session-process-routes.js';
import { createRefreshEventsRoutes } from './refresh-events-routes.js';

// このファイルはリソース別のルートモジュールを元の登録順で束ねる合成レイヤ
// (bdboard-sso1.1)。旧 routes.ts (1973行、39ルートが同居) をリソース別に分割した際、
// Hono は登録順でルート解決する (GET /api/tickets/:id{.+} のような catch-all は
// 具体ルートより後で登録する必要がある) ため、分割後もこのファイルの中で元と同じ順序
// のまま各グループの register 関数を呼ぶ。write-guard ミドルウェア (app.use('*', ...))
// も、どのグループより前に一度だけ適用する元の構造を保っている。
//
// サブ Hono を app.route('/', sub) で載せる方式そのものは main.ts で既に使われている
// パターンで、app.use('*', ...) を先に登録しておけば後から route() されるサブアプリの
// ルートにも適用される (main.ts の createCompressionMiddleware がその実例)。ただし
// 「catch-all より後にサブパスを mount する」という順序依存を壊すと bdboard-qw26
// (PR #514) と同じ事故になるため、グループの呼び出し順序は変更しないこと。
//
// ハンドラ本体・zod スキーマ・ヘルパー関数のロジックは各グループのファイルへ
// 一字一句そのまま移した (import/export の付け外しとインデント変化のみ)。
// /api/hygiene と /api/tickets/:id/in-flight-overlaps は着手中重複メモを共有する
// 必要があるため (元は createApiRoutes 内の1個のクロージャ)、createInFlightOverlapMemo()
// で1個だけ作ってその2グループへ渡す。

// bdboard-tml8: ApiStatus/ApiDeps の実体は api-deps.ts (このファイルとの型だけの
// import 循環を dependency-cruiser no-circular が検出したため抽出)。外部
// (bootstrap・テスト等) から従来どおり routes.ts 経由でも参照できるよう再輸出する。
export type { ApiStatus, ApiDeps } from './api-deps.js';

// 外部 (routes.test.ts) から型として参照され続けられるよう re-export する。
// 実体は ticket-read-routes.ts (/api/tickets/pending-decisions が使う)。
export type { PendingDecisionDto } from './ticket-read-routes.js';

export function createApiRoutes(deps: ApiDeps): Hono {
  const app = new Hono();

  // 書き込みガードはここ 1 箇所だけ。ルート個別のチェックは持たない(bdboard-9rz)。
  // '*' でメソッド判定するので、この下に後から足された POST/PUT/PATCH/DELETE は
  // 登録しただけでガードの内側に入る。ハンドラが存在しないパスへの書き込みも
  // ルーティング解決より前に 403 になる(= ガード掛け忘れで出荷される経路が無い)。
  app.use('*', createWriteGuardMiddleware(deps.writeAccess ?? {}));

  // /api/hygiene (hygiene-status-routes.ts, bdboard-sso1.61 で hygiene-routes.ts
  // から分割) と /api/tickets/:id/in-flight-overlaps
  // (ticket-read-routes.ts) が共有する着手中重複メモ。
  const inFlightOverlapMemo = createInFlightOverlapMemo();

  // 元の routes.ts の登録順そのまま: health/status → board/projects/search/activity →
  // stats 系 → hygiene 系 → tickets 読み取り (catch-all含む) → tickets 書き込み →
  // comments → sessions/processes → refresh/events(SSE)。
  app.route('/', createHealthStatusRoutes(deps));
  app.route('/', createBoardRoutes(deps));
  app.route('/', createStatsRoutes(deps));
  app.route('/', createHygieneRoutes(deps, inFlightOverlapMemo));
  app.route('/', createTicketReadRoutes(deps, inFlightOverlapMemo));
  app.route('/', createTicketWriteRoutes(deps));
  app.route('/', createCommentRoutes(deps));
  app.route('/', createSessionProcessRoutes(deps));
  app.route('/', createRefreshEventsRoutes(deps));

  return app;
}
