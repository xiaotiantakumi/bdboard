import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { runBdVersionStartupCheck } from './application/bd/run-bd-version-startup-check.js';
import { createShutdownDrain } from './application/board/shutdown-drain.js';
import {
  DEFAULT_RECLAIM_INTERVAL_MS,
  DEFAULT_RECLAIM_OLDER_THAN,
} from './application/lease/reclaim-scheduler.js';
import {
  createFileAiQuotaAlertConfigStore,
  createFileBoardThresholdsConfigStore,
  createFileHygieneThresholdsConfigStore,
  createFileScanRootsConfigStore,
  createFsHarnessContractReader,
  createPackageJsonVersionProvider,
  createPsProcessScanner,
  createSqliteBoardCache,
  NodeCommandRunner,
  NodeFileSystem,
  NodeStreamingCommandRunner,
  readBdVersion,
  resolveConfigFilePath,
} from './infrastructure/index.js';
import { resolveAuthMode } from './interface/http/basic-auth.js';
import {
  describePlatformSupport,
  isPlatformFeatureSupported,
  unrestrictedPlatformSupport,
} from './domain/platform-support.js';
import { createSessionValidator } from './interface/http/tunnel-session.js';
import { buildApiDeps } from './interface/http/build-api-deps.js';
import { createApiRoutes } from './interface/http/routes.js';
import { createScanRootsRoutes } from './interface/http/scan-roots-routes.js';
import { createBoardThresholdsRoutes } from './interface/http/board-thresholds-routes.js';
import { createHygieneThresholdsRoutes } from './interface/http/hygiene-thresholds-routes.js';
import { createDbStatsRoutes } from './interface/http/db-stats-routes.js';
import { createAiQuotaAlertRoutes } from './interface/http/ai-quota-alert-routes.js';
import { readProjectMainBranch } from './application/harness/get-project-harness-status.js';
import { resolveDefaultScanRoots } from './infrastructure/discovery/default-scan-roots.js';
import { resolveWebDistDir } from './infrastructure/web/resolve-web-dist-dir.js';
import { createTunnelRoutes } from './interface/http/tunnel-routes.js';
import { createEventHub } from './interface/sse/event-hub.js';
import {
  createGracefulShutdown,
  DEFAULT_SHUTDOWN_TIMEOUT_MS,
} from './interface/http/graceful-shutdown.js';
import {
  envBool,
  envBoolDefaultTrue,
  envInt,
  envOptionalString,
  envString,
} from './bootstrap/env.js';
import { wireBdServices } from './bootstrap/wire-bd-services.js';
import { wireAttachments } from './bootstrap/wire-attachments.js';
import { wireHarness } from './bootstrap/wire-harness.js';
import { wireTunnel } from './bootstrap/wire-tunnel.js';
import { wireAgentRun } from './bootstrap/wire-agent-run.js';
import { wireChat } from './bootstrap/wire-chat.js';
import { wireAiQuotaWidget } from './bootstrap/wire-ai-quota-widget.js';
import { wireUpdateCheck } from './bootstrap/wire-update-check.js';
import { wireBoardReclaim } from './bootstrap/wire-board-reclaim.js';
import { wireBoardRefresh } from './bootstrap/wire-board-refresh.js';
import {
  createBoardSessionServices,
  runInitialSessionsFetch,
  startSessionInterval,
  startTranscriptInterval,
} from './bootstrap/wire-board-sessions.js';
import { mountRoutes, type StaticSpaDeps } from './bootstrap/mount-routes.js';

async function main(): Promise<void> {
  const applicationVersion = createPackageJsonVersionProvider();
  const instanceNonce = envOptionalString('BDBOARD_INSTANCE_NONCE');
  const bdVersionCheckTimeoutMs = 3_000;
  const port = envInt('BDBOARD_PORT', 8787);
  const host = envString('BDBOARD_HOST', '127.0.0.1');
  const dbPath = envString('BDBOARD_DB', path.join(os.homedir(), '.bdboard', 'cache.db'));
  const refreshIntervalMs = envInt('BDBOARD_REFRESH_INTERVAL_MS', 300_000);
  const sessionIntervalMs = envInt('BDBOARD_SESSION_INTERVAL_MS', 10_000);
  const transcriptIntervalMs = envInt('BDBOARD_TRANSCRIPT_INTERVAL_MS', 30_000);
  const shutdownTimeoutMs = envInt('BDBOARD_SHUTDOWN_TIMEOUT_MS', DEFAULT_SHUTDOWN_TIMEOUT_MS);
  const cfdSnapshotIntervalMs = envInt('BDBOARD_CFD_SNAPSHOT_INTERVAL_MS', 3_600_000);
  const cfdSnapshotRetentionDays = envInt('BDBOARD_CFD_SNAPSHOT_RETENTION_DAYS', 365);
  const bdPath = envString('BDBOARD_BD_PATH', 'bd');
  const ghPath = envString('BDBOARD_GH_PATH', 'gh');
  const reclaimEnabled = envBoolDefaultTrue('BDBOARD_RECLAIM_ENABLED');
  const reclaimIntervalMs = envInt('BDBOARD_RECLAIM_INTERVAL_MS', DEFAULT_RECLAIM_INTERVAL_MS);
  const reclaimOlderThan = envString('BDBOARD_RECLAIM_OLDER_THAN', DEFAULT_RECLAIM_OLDER_THAN);

  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const cache = createSqliteBoardCache(dbPath);
  const fsPort = new NodeFileSystem();
  const commandRunner = new NodeCommandRunner();
  // 診断だけが目的なので、bd が未導入・壊れている場合も起動を止めない。
  void runBdVersionStartupCheck(
    () => readBdVersion(commandRunner, bdPath, bdVersionCheckTimeoutMs, process.cwd()),
    console,
  );
  const streamingCommandRunner = new NodeStreamingCommandRunner();
  const configFilePath = resolveConfigFilePath();
  const scanRootsConfigStore = createFileScanRootsConfigStore(
    envString('BDBOARD_SCAN_ROOTS_CONFIG_PATH', configFilePath),
  );
  const boardThresholdsConfigStore = createFileBoardThresholdsConfigStore(
    envString('BDBOARD_BOARD_THRESHOLDS_CONFIG_PATH', configFilePath),
  );
  const hygieneThresholdsConfigStore = createFileHygieneThresholdsConfigStore(
    envString('BDBOARD_HYGIENE_THRESHOLDS_CONFIG_PATH', configFilePath),
  );
  const aiQuotaAlertConfigStore = createFileAiQuotaAlertConfigStore(
    envString('BDBOARD_AI_QUOTA_ALERT_CONFIG_PATH', configFilePath),
  );

  const {
    repository,
    leaseReader,
    mergeSlotReader,
    leaseReclaimer,
    commentReader,
    prStatusReader,
    humanDecisions,
    worktreeScanner,
    issueWriter,
    dependencyWriter,
    sessionLinkWriter,
  } = wireBdServices(commandRunner, { bdPath, ghPath });

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

  const processScanner = createPsProcessScanner(commandRunner);
  const events = createEventHub();

  const boardSessionServices = createBoardSessionServices({ fsPort, cache, events });

  const boardRefreshServices = await wireBoardRefresh({
    env: process.env,
    fsPort,
    commandRunner,
    scanRootsConfigStore,
    repository,
    cache,
    humanDecisions,
    events,
    refreshIntervalMs,
    cfdSnapshotIntervalMs,
    cfdSnapshotRetentionDays,
  });

  await runInitialSessionsFetch(boardSessionServices, platformSupport, sessionDiscoverySupported);

  boardRefreshServices.finishInitialization();

  const transcriptIntervalTimer = await startTranscriptInterval(boardSessionServices, {
    cache,
    transcriptIntervalMs,
  });

  const { watchHandle, refreshIntervalTimer, cfdSnapshotIntervalTimer } =
    await boardRefreshServices.startWatchAndIntervals();

  const sessionIntervalTimer = startSessionInterval(
    boardSessionServices,
    sessionDiscoverySupported,
    sessionIntervalMs,
  );

  const { reclaimScheduler, reclaimHistory } = wireBoardReclaim({
    leaseReclaimer,
    leaseReader,
    worktreeScanner,
    cache,
    reclaimEnabled,
    reclaimIntervalMs,
    reclaimOlderThan,
  });

  const authMode = resolveAuthMode(process.env);
  const authUsername = envString('BDBOARD_AUTH_USER', 'bdboard');

  const { tunnelService, tunnelAccess } = await wireTunnel({
    env: process.env,
    port,
    dbPath,
    authUsername,
  });

  if (authMode.kind === 'enabled') {
    console.log('Basic auth: enabled');
  } else if (authMode.kind === 'disabled-explicitly') {
    console.log('Basic auth: DISABLED explicitly (BDBOARD_AUTH_DISABLED)');
  } else {
    console.log(
      'Basic auth: not configured; local direct requests are allowed, while remote requests return 503 and tunnel publishing is disabled. Set BDBOARD_AUTH_USER and BDBOARD_AUTH_PASSWORD to publish.',
    );
  }

  // トンネル経由の書き込み開放(bdboard-9rz)。判定は write-guard 1 箇所に集約して
  // あるので、ここでは材料(パスワード強度・セッション Cookie の有効性)を渡すだけ。
  // bdboard-cu4 でチャットも同じ材料を共有する(片方だけ緩むのを構造的に防ぐ)。
  const writeAccess = {
    isTunnelWriteAllowed: () => tunnelService.isWriteAllowed(),
    hasTunnelSession: createSessionValidator(tunnelAccess),
  };

  // /api/hygiene (getProjectMainBranch) と harness routes の両方が使う。createApiRoutes より
  // 前で作る — 後ろで宣言するとクロージャが TDZ の前方参照になる (bdboard-pkr6.19)。
  const harnessContractReader = createFsHarnessContractReader();
  const refreshProjectByRootPath = async (rootPath: string): Promise<void> => {
    const projectId = cache
      .listProjects()
      .find((entry) => entry.project.rootPath === rootPath)?.project.id;
    // キャッシュに無い rootPath は絞り込みようがないので、安全側に倒して
    // 従来どおり全体を強制リフレッシュする。
    await boardRefreshServices.runRefresh(true, projectId === undefined ? undefined : [projectId]);
  };
  const inner = createApiRoutes(
    buildApiDeps({
      cache,
      applicationVersion,
      instanceNonce,
      now: () => new Date(),
      getStatus: boardRefreshServices.getStatus,
      refresh: () => boardRefreshServices.runRefresh(true),
      refreshProjectByRootPath,
      events,
      boardThresholdsConfigStore,
      hygieneThresholdsConfigStore,
      sessions: () => boardSessionServices.sessionLivenessTracker.current(),
      links: () => boardSessionServices.transcriptLinkTracker.list(),
      commentReader,
      prStatusReader,
      processScanner,
      humanDecisions,
      worktreeScanner,
      // 失敗時の握りつぶしは /api/hygiene 側 (既定の候補順へフォールバック) が持つ。
      getProjectMainBranch: (rootPath: string) =>
        readProjectMainBranch(harnessContractReader, rootPath),
      issueWriter,
      dependencyWriter,
      sessionLinkWriter,
      sessionTail: boardSessionServices.sessionTailReader,
      writeAccess,
      leaseReader,
      mergeSlotReader,
      reclaimScheduler,
      reclaimHistory,
    }),
  );

  const app = new Hono();
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

  const { attachmentsRouter } = wireAttachments({
    repoRoot,
    env: process.env,
    cache,
    writeAccess,
  });

  const { harnessRouter, packRegistry, harnessInjector } = wireHarness({
    repoRoot,
    cache,
    harnessContractReader,
    writeAccess,
    issueWriter,
    refreshProjectByRootPath,
  });

  const scanRootsRouter = createScanRootsRoutes({
    store: scanRootsConfigStore,
    writeAccess,
    isEnvOverridden: boardRefreshServices.isScanRootsEnvOverridden,
    envScanRoots: boardRefreshServices.isScanRootsEnvOverridden
      ? boardRefreshServices.envScanRootsList
      : undefined,
    resolveDefaultScanRoots: () => resolveDefaultScanRoots(fsPort),
  });

  const boardThresholdsRouter = createBoardThresholdsRoutes({
    store: boardThresholdsConfigStore,
    writeAccess,
  });

  const hygieneThresholdsRouter = createHygieneThresholdsRoutes({
    store: hygieneThresholdsConfigStore,
    writeAccess,
  });

  const dbStatsRouter = createDbStatsRoutes({ cache });

  const aiQuotaAlertRouter = createAiQuotaAlertRoutes({
    store: aiQuotaAlertConfigStore,
    writeAccess,
  });

  const { agentRunSettingsRouter, agentRunRouter, runStore } = await wireAgentRun({
    env: process.env,
    configFilePath,
    cache,
    commandRunner,
    streamingCommandRunner,
    ghPath,
    writeAccess,
    issueWriter,
    packRegistry,
    harnessInjector,
    harnessContractReader,
  });

  const tunnelRouter = createTunnelRoutes({
    tunnelService,
    authEnabled: authMode.kind === 'enabled',
    access: tunnelAccess,
  });

  const { updateCheckRouter } = wireUpdateCheck({ env: process.env, applicationVersion });

  const { aiQuotaRouter, aiQuotaAlertIntervalTimer } = wireAiQuotaWidget({
    env: process.env,
    aiQuotaDisabled: envBool('BDBOARD_AI_QUOTA_DISABLED'),
    commandRunner,
    events,
    aiQuotaAlertConfigStore,
  });

  const { chatRouter, chatCloseables } = wireChat({
    env: process.env,
    chatDisabled: envBool('BDBOARD_CHAT_DISABLED'),
    cache,
    chatSessionDiscovery: boardSessionServices.chatSessionDiscovery,
    dbPath,
    commandRunner,
    streamingCommandRunner,
    writeAccess,
  });

  const webDistDir = resolveWebDistDir(repoRoot, process.env);
  const spaIndexPath = path.join(webDistDir, 'index.html');
  let staticSpa: StaticSpaDeps | undefined;
  if (fs.existsSync(spaIndexPath)) {
    const spaIndexHtml = fs.readFileSync(spaIndexPath, 'utf8');
    console.log(`Serving static web UI from ${webDistDir}`);
    staticSpa = { webDistDir, spaIndexHtml };
  } else {
    console.log('web/dist not found; serving API only');
  }

  mountRoutes(app, {
    security: {
      authMode,
      access: tunnelAccess,
      getExtraCredentials: () => tunnelService.getCredentials(),
    },
    platformSupport,
    attachmentsRouter,
    inner,
    harnessRouter,
    scanRootsRouter,
    boardThresholdsRouter,
    hygieneThresholdsRouter,
    dbStatsRouter,
    aiQuotaAlertRouter,
    agentRunSettingsRouter,
    agentRunRouter,
    tunnelRouter,
    updateCheckRouter,
    aiQuotaRouter,
    chatRouter,
    staticSpa,
  });

  const server = serve({
    fetch: app.fetch,
    port,
    hostname: host,
  });

  console.log(`bdboard listening on http://${host}:${port}`);
  console.log(`Shutdown timeout: ${shutdownTimeoutMs}ms`);

  // server.close() の解決を待たない後始末(タイマー類の停止)は即座に、SSE 等の張りっぱなし
  // 接続の drain 待ちが絡む後始末(watcher/tunnel/cache)は createGracefulShutdown の
  // drain に委ねてタイムアウト保護をかける (bdboard-3tw.91)。
  const drain = createShutdownDrain({
    runStore,
    watchHandle,
    tunnelService,
    cache,
    chatRepositories: chatCloseables,
  });

  const shutdown = createGracefulShutdown({
    drain,
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
    timeoutMs: shutdownTimeoutMs,
    exit: (code) => process.exit(code),
    onError: (err) => {
      const detail = err instanceof Error ? err.message : String(err);
      console.error(`Shutdown drain error: ${detail}`);
    },
    onTimeout: () => {
      console.error(
        `Shutdown did not drain within ${shutdownTimeoutMs}ms; forcing existing connections (e.g. SSE) closed`,
      );
    },
  });

  const shutdownForSignal = (): void => {
    clearInterval(refreshIntervalTimer);
    if (sessionIntervalTimer !== null) {
      clearInterval(sessionIntervalTimer);
    }
    if (transcriptIntervalTimer !== undefined) {
      clearInterval(transcriptIntervalTimer);
    }
    if (cfdSnapshotIntervalTimer !== undefined) {
      clearInterval(cfdSnapshotIntervalTimer);
    }
    if (aiQuotaAlertIntervalTimer !== undefined) {
      clearInterval(aiQuotaAlertIntervalTimer);
    }
    reclaimScheduler.stop();
    shutdown();
  };

  process.on('SIGINT', shutdownForSignal);
  process.on('SIGTERM', shutdownForSignal);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
