import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { BoardCache } from '../../application/ports/board-cache.js';
import type { IssueWriterPort } from '../../application/ports/issue-writer.js';
import type { WorktreeProvisioner } from '../../application/ports/worktree-provisioner.js';
import type { AgentRunnerRegistry } from '../../application/runner/runner-registry.js';
import type { RunStore } from '../../application/runner/run-store.js';
import type { ProjectHarnessStatus } from '../../domain/harness-pack.js';
import {
  createAgentRunRateLimitMiddleware,
  createChatRateLimiter,
  DEFAULT_AGENT_RUN_RATE_LIMIT_PER_DAY,
  DEFAULT_AGENT_RUN_RATE_LIMIT_PER_MINUTE,
} from './agent-run-rate-limit.js';
import { mountAgentRunGuard } from './agent-run-guard.js';
import type { WriteGuardDeps } from './write-guard.js';
import { createAgentRunCreateRoutes } from './agent-run-create-routes.js';
import { createAgentRunReadRoutes } from './agent-run-read-routes.js';
import { createAgentRunCancelRoutes } from './agent-run-cancel-routes.js';

// bdboard-sso1.27: agent-run-routes.ts (497行, 分割前 672行) を、ルート別の登録関数
// (agent-run-create-routes.ts / agent-run-read-routes.ts / agent-run-cancel-routes.ts)
// と共有ヘルパー (agent-run-shared.ts) へ分割した (move only, 挙動変更ゼロ)。この
// ファイルは合成層として残り、公開 API (createAgentRunRoutes・AgentRunRoutesDeps・
// AGENT_RUN_BODY_MAX_BYTES) は分割前と同一。トップレベルのミドルウェア
// (agentRunGuard・agentRunBodyLimit・rateLimit) はどのグループを跨いでも適用順が
// 変わってはいけないため、ここに残したまま各グループのルート登録より先に呼ぶ
// (元のファイルでの並び: ミドルウェア4件 → ルート4件、をそのまま維持。ticket-write-routes.ts
// 分割 bdboard-sso1.25 / chat-routes.ts 分割 bdboard-sso1.17 と同じ方針)。
//
// bdboard-3knf: 分割後、createAgentRunCreateRoutes/ReadRoutes/CancelRoutes を将来の
// 別ファイルが直接 import してガード無しでマウントできてしまう穴が型システム上は
// 塞がれていなかった (「単一の守られた経路」という不変条件が convention 頼みだった)。
// 各ファクトリは今、mountAgentRunGuard() が発行する AgentRunGuardToken (agent-run-guard.ts、
// 未エクスポートの unique symbol でブランド化) を必須第2引数として要求する。トークンを
// 得る唯一の方法が mountAgentRunGuard(app, ...) の呼び出しなので、このファイルを経由
// せずにこれらのファクトリを import して呼ぶコードは型チェックで弾かれる (sole-importer
// を agent-run-route-factories-guard.test.ts が固定)。
//
// bdboard-v0df: 当初のトークンは「mountAgentRunGuard() がどこかで呼ばれた」ことしか
// 証明せず、どの app に適用したかへは結び付いていなかった (opus レビュー, 2026-09-24)。
// 今はトークンがガード適用先の Hono インスタンスそのものを保持し (guardedApp())、
// 各ファクトリはそのインスタンスへ直接ハンドラを登録する — 独立してマウント可能な
// Hono を自前で作って返すことはしない。詳細は agent-run-guard.ts の
// AGENT_RUN_GUARD_APPLIED 直前のコメントを参照。

/** postRunsBodySchema は ticketId と mode だけなので 4KB で十分すぎる。 */
export const AGENT_RUN_BODY_MAX_BYTES = 4 * 1024;

export interface AgentRunRoutesDeps {
  readonly cache: BoardCache;
  readonly registry: AgentRunnerRegistry;
  readonly runStore: RunStore;
  readonly worktreeProvisioner: WorktreeProvisioner;
  /**
   * spawn 直前の cwd ガードで使うパス正規化。composition root (src/main.ts) が
   * infrastructure の `normalizePathForComparison` (realpath) を注入する。
   * interface 層から infrastructure を直 import できない (check:boundaries の
   * `interface-no-infrastructure`) ので依存として受け取る。
   * 必須依存にしてあるのは、省略できると symlink 越しのプロジェクトで再利用 worktree が
   * 弾かれる不具合 (major-1) に黙って戻れてしまうため。正規化不要な呼び出し元は
   * 恒等関数を明示的に渡すこと。
   */
  readonly normalizePath: (pathValue: string) => string;
  /**
   * リポジトリ根のハーネス状態を読む application 層の use case
   * (`readProjectHarnessStatus`)。preflight (bdboard-pkr6.11) の入力で、
   * interface 層から infrastructure を直接触らないために注入で受ける。
   * 判定に使うのは **worktree ではなくリポジトリ根**の `.claude/`。
   */
  readonly getHarnessStatus: (repoRootPath: string) => Promise<ProjectHarnessStatus>;
  readonly writeAccess?: WriteGuardDeps;
  readonly isRemoteAgentRunAllowed: () => Promise<boolean>;
  readonly now: () => Date;
  readonly rateLimit?: {
    readonly perMinute?: number;
    readonly perDay?: number;
  };
  /**
   * run 開始時にサーバー側でチケットを claim するための port (bdboard-pkr6.26)。
   *
   * これが無いと run は worktree を作って実際にファイルを編集するのに、bd 上は
   * open のままで他セッションの `bd ready` に出続け、二重着手を招く
   * (ハーネスの「worktree-first 排他」規律の穴)。claim/unclaim は
   * IssueWriterPort の既存実装 (bd update --claim / bd unclaim) をそのまま使う。
   *
   * `bd update --claim` の実測 (bdboard-pkr6.26 調査, 2026-09-19): 同一アクターの
   * 再 claim は revision すら変わらない真の no-op で exit 0 (reopen/undefer
   * (bdboard-3tw.93) のような「前提を満たさなくても no-op」パターンではない)。
   * 別アクターが既に保持しているときは exit 1 "issue already claimed by <assignee>"
   * で明確に失敗する。よって claim の失敗はそのまま run 開始を止める根拠にできる
   * (reopen/undefer のような read-then-write CAS 前段の状態確認は不要)。
   */
  readonly issueWriter: IssueWriterPort;
}

export function createAgentRunRoutes(deps: AgentRunRoutesDeps): Hono {
  const app = new Hono();

  // Hono の app.route('/', sub) はサブアプリの '*' を親の '/*' として再登録するため、
  // '*' で登録すると main.ts でこのマウントより後に登録される全ハンドラ
  // (tunnel / update-check / ai-quota / chat / serveStatic / SPA フォールバック) に
  // ガードが漏れる。実測でリモートからボードが全損した。自分の持ちパスにだけ
  // スコープすること。コレクションとワイルドカードの両方を登録するのは
  // main.ts / chat-routes.ts と同じ作法 (掛け忘れ防止)。
  const guardToken = mountAgentRunGuard(app, {
    writeAccess: deps.writeAccess,
    isRemoteAgentRunAllowed: deps.isRemoteAgentRunAllowed,
  });

  const limiter = createChatRateLimiter({
    now: deps.now,
    perMinute:
      deps.rateLimit?.perMinute ?? DEFAULT_AGENT_RUN_RATE_LIMIT_PER_MINUTE,
    perDay: deps.rateLimit?.perDay ?? DEFAULT_AGENT_RUN_RATE_LIMIT_PER_DAY,
  });
  const rateLimit = createAgentRunRateLimitMiddleware(limiter);
  const agentRunBodyLimit = bodyLimit({
    maxSize: AGENT_RUN_BODY_MAX_BYTES,
    onError: (c) => c.json({ error: 'request body too large' }, 413),
  });

  // Hono の app.use('/api/runs', mw) は /api/runs 完全一致のみ。/api/runs/:runId や
  // /api/runs/:runId/cancel には掛けない — 前者は GET のログ取得、後者は子プロセスを
  // 増やさない安価な操作。ガードより後に置き、未認可リクエストがレート枠を消費しないようにする。
  app.use('/api/runs', agentRunBodyLimit);
  app.use('/api/runs', rateLimit);

  // bdboard-v0df: the three factories now register their handlers directly onto `app`
  // (the exact instance mountAgentRunGuard() just guarded, obtained internally via
  // guardedApp(guardToken)) instead of returning an independently mountable Hono of
  // their own. There is nothing left to `app.route()` here — calling each factory is
  // itself the mount step, at the routes' real absolute paths, in the same order as
  // before.
  createAgentRunCreateRoutes(deps, guardToken);
  createAgentRunReadRoutes(deps, guardToken);
  createAgentRunCancelRoutes(deps, guardToken);

  return app;
}
