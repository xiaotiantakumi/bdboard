/**
 * bdboard-sso1.14: src/main.ts (composition root) からハーネスパック領域の
 * 配線を切り出したもの (move only, 挙動変更ゼロ)。
 *
 * `packRegistry` / `harnessInjector` は agent-run routes の `getHarnessStatus`
 * (bdboard-pkr6.11) とも共有するため、ここで組み立てた両者をそのまま返す。
 * `harnessContractReader` は routes.ts (buildApiDeps) 側でも使う横断的な値の
 * ため main.ts 側で作り、ここには引数として渡す (元のコード上の役割分担を
 * そのまま保つ — createApiRoutes より前で作らないと TDZ の前方参照になる
 * bdboard-pkr6.19 の事情はこのファイルの対象外)。
 */
import path from 'node:path';
import type { Hono } from 'hono';
import type { BoardCache } from '../application/ports/board-cache.js';
import type { WriteGuardDeps } from '../interface/http/write-guard.js';
import type { IssueWriterPort } from '../application/ports/issue-writer.js';
import type { HarnessContractReaderPort } from '../application/ports/harness-contract-reader.js';
import { createHarnessRoutes } from '../interface/http/harness-routes.js';
import { createFsPackRegistry, createFsHarnessInjector } from '../infrastructure/index.js';

export interface WireHarnessDeps {
  readonly repoRoot: string;
  readonly cache: BoardCache;
  readonly harnessContractReader: HarnessContractReaderPort;
  readonly writeAccess: WriteGuardDeps;
  readonly issueWriter: IssueWriterPort;
  readonly refreshProjectByRootPath: (rootPath: string) => Promise<void>;
}

export function wireHarness(deps: WireHarnessDeps) {
  const harnessPacksRoot = path.join(deps.repoRoot, 'harness', 'packs');
  const packRegistry = createFsPackRegistry(harnessPacksRoot);
  const harnessInjector = createFsHarnessInjector({ packsRoot: harnessPacksRoot });

  const harnessRouter: Hono = createHarnessRoutes({
    cache: deps.cache,
    registry: packRegistry,
    injector: harnessInjector,
    contractReader: deps.harnessContractReader,
    writeAccess: deps.writeAccess,
    issueWriter: deps.issueWriter,
    refreshProjectByRootPath: deps.refreshProjectByRootPath,
  });

  return { harnessRouter, packRegistry, harnessInjector };
}
