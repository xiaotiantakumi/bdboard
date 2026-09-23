import { Hono } from 'hono';
import type { BoardCache } from '../../application/ports/board-cache.js';
import type { HarnessContractReaderPort } from '../../application/ports/harness-contract-reader.js';
import type { HarnessInjectorPort } from '../../application/ports/harness-injector.js';
import type { IssueWriterPort } from '../../application/ports/issue-writer.js';
import type { PackRegistryPort } from '../../application/ports/pack-registry.js';
import {
  createWriteGuardMiddleware,
  type WriteGuardDeps,
} from './write-guard.js';
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

export interface HarnessRoutesDeps {
  readonly cache: BoardCache;
  readonly registry: PackRegistryPort;
  readonly injector: HarnessInjectorPort;
  readonly contractReader: HarnessContractReaderPort;
  readonly now?: () => Date;
  readonly writeAccess?: WriteGuardDeps;
  /**
   * 検証コントラクト不足のチケット起票 (`POST .../harness/contract-ticket`,
   * bdboard-p5l.25) にだけ使う。`create`/`findOpenTicketByLabel`/`setMetadata`
   * (いずれも optional) を持たない実装が渡された場合、そのルートは 501 を返す
   * (bdboard-13mp: state 遷移をまたいだ追記に setMetadata も必須化)。
   */
  readonly issueWriter?: IssueWriterPort;
  /**
   * チケット作成後にそのプロジェクトのキャッシュを強制リフレッシュするフック。
   * routes.ts の refreshAfterWrite と同じ目的・同じ fail-open 方針 (失敗しても
   * 書き込み自体は成功扱い) — 未指定ならリフレッシュしない。
   */
  readonly refreshProjectByRootPath?: (rootPath: string) => Promise<void>;
}

export function createHarnessRoutes(deps: HarnessRoutesDeps): Hono {
  const app = new Hono();
  const now = deps.now ?? (() => new Date());

  app.use('*', createWriteGuardMiddleware(deps.writeAccess ?? {}));

  app.route('/', createHarnessStatusRoutes(deps, { now }));
  app.route('/', createHarnessInjectRoutes(deps, { now }));
  app.route('/', createHarnessContractTicketRoutes(deps, { now }));

  return app;
}
