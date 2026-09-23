/**
 * bdboard-sso1.86: src/main.ts (composition root) から小粒な設定系ルーター
 * (scan-roots / board-thresholds / hygiene-thresholds / db-stats /
 * ai-quota-alert) の組み立てを切り出したもの (move only, 挙動変更ゼロ)。
 */
import type { NodeFileSystem } from '../infrastructure/index.js';
import { resolveDefaultScanRoots } from '../infrastructure/discovery/default-scan-roots.js';
import type { AiQuotaAlertConfigPort } from '../application/ports/ai-quota-alert-config.js';
import type { BoardCache } from '../application/ports/board-cache.js';
import type { BoardThresholdsConfigPort } from '../application/ports/board-thresholds-config.js';
import type { HygieneThresholdsConfigPort } from '../application/ports/hygiene-thresholds-config.js';
import type { ScanRootsConfigPort } from '../application/ports/scan-roots-config.js';
import { createAiQuotaAlertRoutes } from '../interface/http/ai-quota-alert-routes.js';
import { createBoardThresholdsRoutes } from '../interface/http/board-thresholds-routes.js';
import { createDbStatsRoutes } from '../interface/http/db-stats-routes.js';
import { createHygieneThresholdsRoutes } from '../interface/http/hygiene-thresholds-routes.js';
import { createScanRootsRoutes } from '../interface/http/scan-roots-routes.js';
import type { WriteGuardDeps } from '../interface/http/write-guard.js';

export interface WireMiscRoutesDeps {
  readonly fsPort: InstanceType<typeof NodeFileSystem>;
  readonly cache: BoardCache;
  readonly writeAccess: WriteGuardDeps;
  readonly scanRootsConfigStore: ScanRootsConfigPort;
  readonly boardThresholdsConfigStore: BoardThresholdsConfigPort;
  readonly hygieneThresholdsConfigStore: HygieneThresholdsConfigPort;
  readonly aiQuotaAlertConfigStore: AiQuotaAlertConfigPort;
  readonly isScanRootsEnvOverridden: boolean;
  readonly envScanRootsList: readonly string[];
}

export function wireMiscRoutes(deps: WireMiscRoutesDeps) {
  const scanRootsRouter = createScanRootsRoutes({
    store: deps.scanRootsConfigStore,
    writeAccess: deps.writeAccess,
    isEnvOverridden: deps.isScanRootsEnvOverridden,
    envScanRoots: deps.isScanRootsEnvOverridden ? deps.envScanRootsList : undefined,
    resolveDefaultScanRoots: () => resolveDefaultScanRoots(deps.fsPort),
  });

  const boardThresholdsRouter = createBoardThresholdsRoutes({
    store: deps.boardThresholdsConfigStore,
    writeAccess: deps.writeAccess,
  });

  const hygieneThresholdsRouter = createHygieneThresholdsRoutes({
    store: deps.hygieneThresholdsConfigStore,
    writeAccess: deps.writeAccess,
  });

  const dbStatsRouter = createDbStatsRoutes({ cache: deps.cache });

  const aiQuotaAlertRouter = createAiQuotaAlertRoutes({
    store: deps.aiQuotaAlertConfigStore,
    writeAccess: deps.writeAccess,
  });

  return {
    scanRootsRouter,
    boardThresholdsRouter,
    hygieneThresholdsRouter,
    dbStatsRouter,
    aiQuotaAlertRouter,
  };
}
