import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { createPackageJsonVersionProvider } from './infrastructure/index.js';
import {
  describePlatformSupport,
  isPlatformFeatureSupported,
  unrestrictedPlatformSupport,
} from './domain/platform-support.js';
import { envBool } from './bootstrap/env.js';
import { resolveMainConfig } from './bootstrap/resolve-main-config.js';
import { wireCoreInfra } from './bootstrap/wire-core-infra.js';
import { wireBdServices } from './bootstrap/wire-bd-services.js';
import { wireBoardLifecycle } from './bootstrap/wire-board-lifecycle.js';
import { wireAuthAndTunnel } from './bootstrap/wire-auth-and-tunnel.js';
import { wireBoardApi } from './bootstrap/wire-board-api.js';
import { wireAttachments } from './bootstrap/wire-attachments.js';
import { wireHarness } from './bootstrap/wire-harness.js';
import { wireMiscRoutes } from './bootstrap/wire-misc-routes.js';
import { wireFeatureRoutes } from './bootstrap/wire-feature-routes.js';
import { wireShutdown } from './bootstrap/wire-shutdown.js';
import { mountRoutes } from './bootstrap/mount-routes.js';

async function main(): Promise<void> {
  const applicationVersion = createPackageJsonVersionProvider();
  const config = resolveMainConfig();

  const infra = wireCoreInfra({ ...config });

  const bdServices = wireBdServices(infra.commandRunner, { ...config });

  // Windows は「全機能対応」ではなく「機能制限 + 正直な案内」で出す方針
  // (bdboard-70z.9)。BDBOARD_IGNORE_PLATFORM_LIMITS は、独自に環境を整えた
  // 利用者が制限を外して試せるようにするための逃げ道。
  const platformSupport = envBool('BDBOARD_IGNORE_PLATFORM_LIMITS')
    ? unrestrictedPlatformSupport(process.platform)
    : describePlatformSupport(process.platform);
  const sessionDiscoverySupported = isPlatformFeatureSupported(
    platformSupport,
    'session-discovery',
  );

  const lifecycle = await wireBoardLifecycle({
    env: process.env,
    fsPort: infra.fsPort,
    commandRunner: infra.commandRunner,
    scanRootsConfigStore: infra.scanRootsConfigStore,
    repository: bdServices.repository,
    cache: infra.cache,
    humanDecisions: bdServices.humanDecisions,
    platformSupport,
    sessionDiscoverySupported,
    leaseReclaimer: bdServices.leaseReclaimer,
    leaseReader: bdServices.leaseReader,
    worktreeScanner: bdServices.worktreeScanner,
    ...config,
  });

  const auth = await wireAuthAndTunnel({ env: process.env, ...config });

  const boardApi = wireBoardApi({
    cache: infra.cache,
    applicationVersion,
    instanceNonce: config.instanceNonce,
    boardRefreshServices: lifecycle.boardRefreshServices,
    events: lifecycle.events,
    boardThresholdsConfigStore: infra.boardThresholdsConfigStore,
    hygieneThresholdsConfigStore: infra.hygieneThresholdsConfigStore,
    boardSessionServices: lifecycle.boardSessionServices,
    commentReader: bdServices.commentReader,
    prStatusReader: bdServices.prStatusReader,
    processScanner: lifecycle.processScanner,
    humanDecisions: bdServices.humanDecisions,
    worktreeScanner: bdServices.worktreeScanner,
    issueWriter: bdServices.issueWriter,
    dependencyWriter: bdServices.dependencyWriter,
    sessionLinkWriter: bdServices.sessionLinkWriter,
    writeAccess: auth.writeAccess,
    leaseReader: bdServices.leaseReader,
    mergeSlotReader: bdServices.mergeSlotReader,
    reclaimScheduler: lifecycle.reclaimScheduler,
    reclaimHistory: lifecycle.reclaimHistory,
    dbPath: config.dbPath,
  });

  const app = new Hono();
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

  const attachments = wireAttachments({
    repoRoot,
    env: process.env,
    cache: infra.cache,
    writeAccess: auth.writeAccess,
  });

  const harness = wireHarness({
    repoRoot,
    cache: infra.cache,
    harnessContractReader: boardApi.harnessContractReader,
    writeAccess: auth.writeAccess,
    issueWriter: bdServices.issueWriter,
    refreshProjectByRootPath: boardApi.refreshProjectByRootPath,
  });

  const misc = wireMiscRoutes({
    fsPort: infra.fsPort,
    cache: infra.cache,
    writeAccess: auth.writeAccess,
    scanRootsConfigStore: infra.scanRootsConfigStore,
    boardThresholdsConfigStore: infra.boardThresholdsConfigStore,
    hygieneThresholdsConfigStore: infra.hygieneThresholdsConfigStore,
    aiQuotaAlertConfigStore: infra.aiQuotaAlertConfigStore,
    isScanRootsEnvOverridden: lifecycle.boardRefreshServices.isScanRootsEnvOverridden,
    envScanRootsList: lifecycle.boardRefreshServices.envScanRootsList,
  });

  const features = await wireFeatureRoutes({
    env: process.env,
    repoRoot,
    configFilePath: infra.configFilePath,
    cache: infra.cache,
    commandRunner: infra.commandRunner,
    streamingCommandRunner: infra.streamingCommandRunner,
    writeAccess: auth.writeAccess,
    issueWriter: bdServices.issueWriter,
    packRegistry: harness.packRegistry,
    harnessInjector: harness.harnessInjector,
    harnessContractReader: boardApi.harnessContractReader,
    tunnelService: auth.tunnelService,
    authMode: auth.authMode,
    tunnelAccess: auth.tunnelAccess,
    applicationVersion,
    events: lifecycle.events,
    aiQuotaAlertConfigStore: infra.aiQuotaAlertConfigStore,
    chatSessionDiscovery: lifecycle.boardSessionServices.chatSessionDiscovery,
    ...config,
  });

  mountRoutes(app, {
    security: {
      authMode: auth.authMode,
      access: auth.tunnelAccess,
      getExtraCredentials: () => auth.tunnelService.getCredentials(),
    },
    platformSupport,
    attachmentsRouter: attachments.attachmentsRouter,
    inner: boardApi.inner,
    harnessRouter: harness.harnessRouter,
    scanRootsRouter: misc.scanRootsRouter,
    boardThresholdsRouter: misc.boardThresholdsRouter,
    hygieneThresholdsRouter: misc.hygieneThresholdsRouter,
    dbStatsRouter: misc.dbStatsRouter,
    aiQuotaAlertRouter: misc.aiQuotaAlertRouter,
    agentRunSettingsRouter: features.agentRunSettingsRouter,
    agentRunRouter: features.agentRunRouter,
    tunnelRouter: features.tunnelRouter,
    updateCheckRouter: features.updateCheckRouter,
    aiQuotaRouter: features.aiQuotaRouter,
    chatRouter: features.chatRouter,
    staticSpa: features.staticSpa,
  });

  const server = serve({
    fetch: app.fetch,
    port: config.port,
    hostname: config.host,
  });

  console.log(`bdboard listening on http://${config.host}:${config.port}`);
  console.log(`Shutdown timeout: ${config.shutdownTimeoutMs}ms`);

  wireShutdown({
    runStore: features.runStore,
    watchHandle: lifecycle.watchHandle,
    tunnelService: auth.tunnelService,
    cache: infra.cache,
    chatRepositories: features.chatCloseables,
    server: {
      close: (callback) => server.close(callback),
      // ServerType (@hono/node-server) is a union that includes Http2Server, whose
      // TypeScript typings don't declare closeAllConnections even though bdboard only
      // ever runs the plain http.Server variant (no http2 option is passed to serve()).
      // Guard at runtime instead of asserting the type away.
      closeAllConnections: () => {
        const target = server as unknown as { closeAllConnections?: () => void };
        if (typeof target.closeAllConnections === 'function') {
          target.closeAllConnections();
        }
      },
    },
    shutdownTimeoutMs: config.shutdownTimeoutMs,
    refreshIntervalTimer: lifecycle.refreshIntervalTimer,
    sessionIntervalTimer: lifecycle.sessionIntervalTimer,
    transcriptIntervalTimer: lifecycle.transcriptIntervalTimer,
    cfdSnapshotIntervalTimer: lifecycle.cfdSnapshotIntervalTimer,
    aiQuotaAlertIntervalTimer: features.aiQuotaAlertIntervalTimer,
    reclaimScheduler: lifecycle.reclaimScheduler,
  });
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
