import { Hono } from 'hono';
import type { ApplicationVersionProvider } from '../../application/ports/application-version.js';
import type { BoardCache } from '../../application/ports/board-cache.js';
import type { CommentReader } from '../../application/ports/comment-reader.js';
import type { ProcessScanner } from '../../application/ports/process-scanner.js';
import type { HumanDecisionsPort } from '../../application/ports/human-decisions.js';
import type { WorktreeScanner } from '../../application/ports/worktree-scanner.js';
import type { DependencyWriterPort } from '../../application/ports/dependency-writer.js';
import type { IssueWriterPort } from '../../application/ports/issue-writer.js';
import type { SessionLinkWriterPort } from '../../application/ports/session-link-writer.js';
import type { ResolvedBoardThresholds } from '../../domain/board-thresholds.js';
import type { HygieneThresholds } from '../../domain/hygiene.js';
import type { SessionTailReader } from '../../application/ports/session-tail-reader.js';
import type { LeaseReader } from '../../application/ports/lease-reader.js';
import type { MergeSlotReader } from '../../application/ports/merge-slot-reader.js';
import type { PrStatusReader } from '../../application/ports/pr-status-reader.js';
import type { ReclaimScheduler } from '../../application/lease/reclaim-scheduler.js';
import type { ReclaimHistory } from '../../application/lease/reclaim-history.js';
import type { AgentSession, SessionLink } from '../../domain/session.js';
import type { EventHub } from '../sse/event-hub.js';
import {
  createWriteGuardMiddleware,
  type WriteGuardDeps,
} from './write-guard.js';
import { createInFlightOverlapMemo } from './api-route-shared.js';
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

export interface ApiStatus {
  readonly lastRefreshAt: Date | null;
  readonly errors: readonly { kind: string; projectId: string; detail: string }[];
  readonly projectCount: number;
}

export interface ApiDeps {
  readonly cache: BoardCache;
  readonly applicationVersion: ApplicationVersionProvider;
  /** e2e 等 per-run 識別子。未設定時は /api/health に含めない (通常運用の応答形を維持)。 */
  readonly instanceNonce?: string;
  readonly now: () => Date;
  readonly getStatus: () => ApiStatus;
  readonly refresh: () => Promise<void>;
  /**
   * 指定した rootPath のプロジェクトだけを強制リフレッシュする(bdboard-6qs6)。
   * 書き込みルートが応答を返す前にこれを await することで、UI が書き込み直後に
   * 再取得しても陳腐化したキャッシュを掴まないようにする。省略された場合は
   * 何もしない(従来どおり定期リフレッシュ/ファイル監視まかせ)。
   */
  readonly refreshProjectByRootPath?: (rootPath: string) => Promise<void>;
  readonly events: EventHub;
  readonly sessions?: () => readonly AgentSession[];
  readonly links?: () => readonly SessionLink[];
  readonly commentReader?: CommentReader;
  readonly processScanner?: ProcessScanner;
  readonly humanDecisions?: HumanDecisionsPort;
  readonly worktreeScanner?: WorktreeScanner;
  /** 注入先の検証コントラクトから mainBranch を読む。失敗時は undefined。 */
  readonly getProjectMainBranch?: (rootPath: string) => Promise<string | undefined>;
  readonly issueWriter?: IssueWriterPort;
  readonly dependencyWriter?: DependencyWriterPort;
  readonly sessionLinkWriter?: SessionLinkWriterPort;
  readonly sessionTail?: SessionTailReader;
  readonly leaseReader?: LeaseReader;
  readonly mergeSlotReader?: MergeSlotReader;
  readonly prStatusReader?: PrStatusReader;
  readonly reclaimScheduler?: ReclaimScheduler;
  /**
   * ハーネス KPI の reclaim 指標用。サーバー起動からの累積で永続化しない
   * (bdboard-pkr6.9)。省略時は reclaim 指標が空になるだけで、他の指標は出る。
   */
  readonly reclaimHistory?: ReclaimHistory;
  /**
   * トンネル経由の書き込みを開放するための依存(bdboard-9rz)。
   * 省略された場合、書き込みは従来どおり localhost 直アクセス限定になる(fail-closed)。
   */
  readonly writeAccess?: WriteGuardDeps;
  readonly getBoardThresholds?: () => Promise<ResolvedBoardThresholds>;
  readonly getHygieneThresholds?: () => Promise<HygieneThresholds>;
}

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
