import { randomInt } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { refreshProjects } from './application/board/refresh-projects.js';
import type { RefreshResult } from './application/board/refresh-projects.js';
import { runInitialRefresh } from './application/board/run-initial-refresh.js';
import { recordCfdSnapshot } from './application/board/record-cfd-snapshot.js';
import { createShutdownDrain } from './application/board/shutdown-drain.js';
import {
  createBoardNotificationPublisher,
  buildSessionDiedNotificationPayload,
} from './application/board/board-notification-transitions.js';
import { createWatchedProjectsSync } from './application/board/sync-watched-projects.js';
import type { WatchedProjectsSync } from './application/board/sync-watched-projects.js';
import {
  createReclaimScheduler,
  DEFAULT_RECLAIM_INTERVAL_MS,
  DEFAULT_RECLAIM_OLDER_THAN,
} from './application/lease/reclaim-scheduler.js';
import { createAiQuotaService } from './application/ai-quota/get-ai-quota.js';
import { createAiQuotaThresholdPublisher } from './application/ai-quota/ai-quota-threshold-alerts.js';
import { createChatSessionStore } from './application/chat/chat-session-store.js';
import { buildChatAgentRegistry } from './infrastructure/chat/chat-agent-registry-builder.js';
import { createTunnelService } from './application/tunnel/tunnel-service.js';
import { createTunnelAccessService } from './application/tunnel/tunnel-access.js';
import type { CachedProject, SessionLinkRow } from './application/ports/board-cache.js';
import {
  computeBoardNotificationSnapshot,
  diffSessionLiveness,
  type BoardSnapshotProjectInput,
} from './domain/board-notifications.js';
import { resolveBoardThresholds } from './domain/board-thresholds.js';
import { resolveAiQuotaAlertThresholdPercent } from './domain/ai-quota-alert-thresholds.js';
import { compareStrings } from './domain/compare.js';
import { generatePassphrase } from './domain/passphrase.js';
import type { AgentSession, SessionLink } from './domain/session.js';
import { MAX_TRANSCRIPT_SESSION_LINKS } from './domain/session.js';
import { parseTicketId } from './domain/ticket-id.js';
import {
  createBdCliCommentReader,
  createBdCliHumanDecisions,
  createBdCliIssueRepository,
  createBdCliLeaseReader,
  createBdCliMergeSlotReader,
  createBdCliLeaseReclaimer,
  createBdCliDependencyWriter,
  createBdCliIssueWriter,
  createBdCliSessionLinkReader,
  createBdCliSessionLinkWriter,
  createBeadsFingerprinter,
  createChokidarProjectWatcher,
  createClaudeSessionRegistry,
  createCloudflaredTunnel,
  createFileTunnelInterruptionStore,
  createFileScanRootsConfigStore,
  createFileBoardThresholdsConfigStore,
  createFileAiQuotaAlertConfigStore,
  createFsHarnessInjector,
  createFsPackRegistry,
  createFsProjectDiscovery,
  createGhCliPrStatusReader,
  createGitSyncHealthReader,
  createGitWorktreeScanner,
  createFsChatSessionDiscovery,
  createJsonlInteractionReader,
  createJsonlTranscriptScanner,
  createNodeAiQuotaSource,
  createPsProcessScanner,
  createSessionTailReader,
  createSqliteBoardCache,
  createSqliteChatMessageRepository,
  createSqliteChatSessionRepository,
  NodeCommandRunner,
  NodeStreamingCommandRunner,
  NodeFileSystem,
  NodeProcessProbe,
  resolveConfigFilePath,
} from './infrastructure/index.js';
import {
  resolveAuthMode,
} from './interface/http/basic-auth.js';
import { mountSecurityMiddleware } from './interface/http/app-security.js';
import { createSessionValidator } from './interface/http/tunnel-session.js';
import { createAiQuotaRoutes } from './interface/http/ai-quota-routes.js';
import { createCompressionMiddleware } from './interface/http/compression.js';
import { createApiRoutes, type ApiStatus } from './interface/http/routes.js';
import { createChatRoutes } from './interface/http/chat-routes.js';
import {
  DEFAULT_CHAT_RATE_LIMIT_WEIGHT,
  DEFAULT_CHAT_RATE_LIMIT_PER_DAY,
  DEFAULT_CHAT_RATE_LIMIT_PER_MINUTE,
} from './interface/http/chat-rate-limit.js';
import { createHarnessRoutes } from './interface/http/harness-routes.js';
import { createScanRootsRoutes } from './interface/http/scan-roots-routes.js';
import { createBoardThresholdsRoutes } from './interface/http/board-thresholds-routes.js';
import { createAiQuotaAlertRoutes } from './interface/http/ai-quota-alert-routes.js';
import { resolveDefaultScanRoots } from './infrastructure/discovery/default-scan-roots.js';
import { createTunnelRoutes } from './interface/http/tunnel-routes.js';
import { createEventHub } from './interface/sse/event-hub.js';
import {
  createGracefulShutdown,
  DEFAULT_SHUTDOWN_TIMEOUT_MS,
} from './interface/http/graceful-shutdown.js';

function envString(name: string, defaultValue: string): string {
  const raw = process.env[name];
  if (raw === undefined || raw === '') {
    return defaultValue;
  }
  return raw;
}

function envBool(name: string): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') {
    return false;
  }

  return raw === '1' || raw.toLowerCase() === 'true';
}

function envBoolDefaultTrue(name: string): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') {
    return true;
  }

  return raw !== '0' && raw.toLowerCase() !== 'false';
}

function envInt(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') {
    return defaultValue;
  }

  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    return defaultValue;
  }

  return parsed;
}

function envFloat(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') {
    return defaultValue;
  }

  const parsed = Number.parseFloat(raw);
  // 負値/0 を受理すると chat-routes.ts 経由のログ・descriptor 表示に「実態と異なる重み」が
  // そのまま載ってしまう(chat-rate-limit.ts の normalizeWeight による <=0 クランプは
  // limiter.consume() 時にしか効かない)。ここで弾いて既定へフォールバックさせる
  // (bdboard-3tw.104.11 Opus レビュー N4、chat-agent-registry-builder.ts の envFloat と同じ判断)。
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return defaultValue;
  }

  return parsed;
}

/** ticketId のプレフィックス(例: "bdboard-3tw.83" -> "bdboard")から所属プロジェクトを引く */
function projectIdForTicketId(
  ticketId: string,
  projects: readonly CachedProject[],
): string | undefined {
  let prefix: string;
  try {
    prefix = parseTicketId(ticketId).prefix;
  } catch {
    return undefined;
  }

  const match = projects.find((entry) => entry.project.prefixes.includes(prefix));
  return match?.project.id;
}

function updateStatusFromResult(
  cache: ReturnType<typeof createSqliteBoardCache>,
  result: RefreshResult,
  refreshedAt: Date,
): ApiStatus {
  return {
    lastRefreshAt: refreshedAt,
    errors: result.errors.map((error) => ({
      kind: error.kind,
      projectId: error.projectId,
      detail: error.detail,
    })),
    projectCount: cache.listProjects().length,
  };
}

async function main(): Promise<void> {
  const port = envInt('BDBOARD_PORT', 8787);
  const host = envString('BDBOARD_HOST', '127.0.0.1');
  const dbPath = envString(
    'BDBOARD_DB',
    path.join(os.homedir(), '.bdboard', 'cache.db'),
  );
  const refreshIntervalMs = envInt('BDBOARD_REFRESH_INTERVAL_MS', 300_000);
  const sessionIntervalMs = envInt('BDBOARD_SESSION_INTERVAL_MS', 10_000);
  const transcriptIntervalMs = envInt('BDBOARD_TRANSCRIPT_INTERVAL_MS', 30_000);
  const shutdownTimeoutMs = envInt(
    'BDBOARD_SHUTDOWN_TIMEOUT_MS',
    DEFAULT_SHUTDOWN_TIMEOUT_MS,
  );
  const cfdSnapshotIntervalMs = envInt('BDBOARD_CFD_SNAPSHOT_INTERVAL_MS', 3_600_000);
  const bdPath = envString('BDBOARD_BD_PATH', 'bd');
  const ghPath = envString('BDBOARD_GH_PATH', 'gh');
  const reclaimEnabled = envBoolDefaultTrue('BDBOARD_RECLAIM_ENABLED');
  const reclaimIntervalMs = envInt(
    'BDBOARD_RECLAIM_INTERVAL_MS',
    DEFAULT_RECLAIM_INTERVAL_MS,
  );
  const reclaimOlderThan = envString(
    'BDBOARD_RECLAIM_OLDER_THAN',
    DEFAULT_RECLAIM_OLDER_THAN,
  );

  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const cache = createSqliteBoardCache(dbPath);
  const fsPort = new NodeFileSystem();
  const commandRunner = new NodeCommandRunner();
  const streamingCommandRunner = new NodeStreamingCommandRunner();
  const configFilePath = resolveConfigFilePath();
  const scanRootsConfigStore = createFileScanRootsConfigStore(
    envString('BDBOARD_SCAN_ROOTS_CONFIG_PATH', configFilePath),
  );
  const boardThresholdsConfigStore = createFileBoardThresholdsConfigStore(
    envString('BDBOARD_BOARD_THRESHOLDS_CONFIG_PATH', configFilePath),
  );
  const aiQuotaAlertConfigStore = createFileAiQuotaAlertConfigStore(
    envString('BDBOARD_AI_QUOTA_ALERT_CONFIG_PATH', configFilePath),
  );

  const scanRootsRaw = process.env.BDBOARD_SCAN_ROOTS;
  const isScanRootsEnvOverridden = scanRootsRaw !== undefined && scanRootsRaw !== '';
  const envScanRootsList = (scanRootsRaw ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  const discovery =
    isScanRootsEnvOverridden
      ? createFsProjectDiscovery(
          {
            scanRoots: envScanRootsList,
          },
          { fs: fsPort, commandRunner },
        )
      : createFsProjectDiscovery(undefined, {
          fs: fsPort,
          commandRunner,
          scanRootsConfigStore,
        });

  const repository = createBdCliIssueRepository(commandRunner, { bdPath });
  const leaseReader = createBdCliLeaseReader(commandRunner, { bdPath });
  const mergeSlotReader = createBdCliMergeSlotReader(commandRunner, { bdPath });
  const leaseReclaimer = createBdCliLeaseReclaimer(commandRunner, { bdPath });
  const commentReader = createBdCliCommentReader(commandRunner);
  const prStatusReader = createGhCliPrStatusReader(commandRunner, { ghPath });
  const humanDecisions = createBdCliHumanDecisions(commandRunner);
  const syncHealthReader = createGitSyncHealthReader(commandRunner, fsPort);
  const worktreeScanner = createGitWorktreeScanner(commandRunner);
  const issueWriter = createBdCliIssueWriter(commandRunner);
  const dependencyWriter = createBdCliDependencyWriter(commandRunner);
  const sessionLinkWriter = createBdCliSessionLinkWriter(commandRunner);
  const sessionLinkReader = createBdCliSessionLinkReader(commandRunner);
  const processScanner = createPsProcessScanner(commandRunner);
  const fingerprinter = createBeadsFingerprinter(fsPort);
  const events = createEventHub();
  const sessionRegistry = createClaudeSessionRegistry(
    fsPort,
    new NodeProcessProbe(),
  );
  const transcriptScanner = createJsonlTranscriptScanner(fsPort, cache);
  const chatSessionDiscovery = createFsChatSessionDiscovery(fsPort);
  const interactionReader = createJsonlInteractionReader(fsPort, cache);
  const sessionTailReader = createSessionTailReader(fsPort);

  let sessions: readonly AgentSession[] = [];
  let previousSessionFingerprint: string | null = null;
  const boardNotificationPublisher = createBoardNotificationPublisher();

  const boardSnapshotInputFromCache = (
    entries: readonly CachedProject[],
  ): readonly BoardSnapshotProjectInput[] =>
    entries.map((entry) => ({
      projectId: entry.project.id,
      tickets: entry.tickets,
      decisionPendingTicketIds: entry.pendingDecisions?.map(
        (decision) => decision.id,
      ),
    }));

  const LINK_KEY_SEP = '\0';
  const MAX_TRANSCRIPT_LINKS = MAX_TRANSCRIPT_SESSION_LINKS;
  const transcriptLinkMap = new Map<string, SessionLink>();

  const linkKey = (link: SessionLink): string =>
    `${link.ticketId}${LINK_KEY_SEP}${link.sessionId}`;

  const trimTranscriptLinksToCap = (): void => {
    if (transcriptLinkMap.size <= MAX_TRANSCRIPT_LINKS) {
      return;
    }

    const sorted = [...transcriptLinkMap.entries()].sort(
      (a, b) => a[1].observedAt.getTime() - b[1].observedAt.getTime(),
    );
    const excess = transcriptLinkMap.size - MAX_TRANSCRIPT_LINKS;
    for (let index = 0; index < excess; index += 1) {
      const entry = sorted[index];
      if (entry !== undefined) {
        transcriptLinkMap.delete(entry[0]);
      }
    }
  };

  // 再起動でのリンク恒久消失を防ぐため、走査で得た新規/更新リンクは即座に SQLite にも
  // upsert する(cache.setTranscriptOffset() は S8 から永続化済みだったが、リンク自体は
  // これまでインメモリのみだった非対称の是正。bdboard-3tw.83)。
  const persistTranscriptLinks = (links: readonly SessionLink[]): void => {
    if (links.length === 0) {
      return;
    }

    const projects = cache.listProjects();
    const rows: SessionLinkRow[] = [];
    for (const link of links) {
      const projectId = projectIdForTicketId(link.ticketId, projects);
      if (projectId === undefined) {
        continue;
      }
      rows.push({ projectId, link });
    }

    if (rows.length > 0) {
      cache.upsertSessionLinks(rows);
    }
  };

  const mergeTranscriptLinks = (newLinks: readonly SessionLink[]): boolean => {
    let hasNew = false;

    for (const link of newLinks) {
      const key = linkKey(link);
      if (!transcriptLinkMap.has(key)) {
        hasNew = true;
      }
      transcriptLinkMap.set(key, link);
    }

    trimTranscriptLinksToCap();
    persistTranscriptLinks(newLinks);
    return hasNew;
  };

  const listTranscriptLinks = (): readonly SessionLink[] => {
    return [...transcriptLinkMap.values()].sort((a, b) => {
      const ticketCmp = compareStrings(a.ticketId, b.ticketId);
      if (ticketCmp !== 0) {
        return ticketCmp;
      }
      return compareStrings(a.sessionId, b.sessionId);
    });
  };

  // 起動時に SQLite の session_links から transcriptLinkMap を再構築する。走査位置
  // (transcript_offsets)は既に永続化されているため、これをやらないと再起動のたびに
  // 過去のリンクが読み直されずに失われる(bdboard-3tw.83)。
  const hydrateTranscriptLinksFromCache = (): void => {
    for (const row of cache.listSessionLinks()) {
      transcriptLinkMap.set(linkKey(row.link), row.link);
    }
    trimTranscriptLinksToCap();
  };

  hydrateTranscriptLinksFromCache();
  console.log(`Hydrated transcript links from cache: count=${transcriptLinkMap.size}`);

  let transcriptScanRunning = false;

  const refreshSessions = async (): Promise<void> => {
    try {
      const prevSessions = sessions;
      const next = await sessionRegistry.listSessions();
      const fingerprint = JSON.stringify(
        next.map(
          (session) =>
            `${session.sessionId}:${session.alive}:${session.lastActivityAt.getTime()}`,
        ),
      );
      const changed =
        previousSessionFingerprint !== null &&
        fingerprint !== previousSessionFingerprint;

      for (const diedEvent of diffSessionLiveness(prevSessions, next)) {
        events.publish({
          name: 'notification',
          data: buildSessionDiedNotificationPayload(diedEvent, new Date()),
        });
      }

      // Always take the newest snapshot: the fingerprint only covers the fields
      // clients react to (id/alive/lastActivityAt), not cwd/name/pid.
      sessions = next;
      previousSessionFingerprint = fingerprint;

      if (changed) {
        events.publish({
          name: 'session.changed',
          data: {
            count: next.length,
            activeCount: next.filter((session) => session.alive).length,
          },
        });
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.error(`Session refresh error: ${detail}`);
    }
  };

  const runTranscriptScan = async (): Promise<void> => {
    if (transcriptScanRunning) {
      return;
    }

    transcriptScanRunning = true;

    try {
      const entries = cache.listProjects();
      const projects = entries.map((entry) => entry.project);
      const knownIdsByProject = new Map(
        entries.map((entry) => [
          entry.project.id,
          new Set(entry.tickets.map((ticket) => ticket.id)),
        ]),
      );

      const newLinks = await transcriptScanner.scan({
        projects,
        knownIdsByProject,
        now: new Date(),
      });

      const hasNew = mergeTranscriptLinks(newLinks);
      if (hasNew) {
        events.publish({
          name: 'board.changed',
          data: {
            refreshed: [],
            reused: [],
            removed: [],
          },
        });
      }

      const newInteractions = await interactionReader.read({ projects });
      if (newInteractions.length > 0) {
        console.log(`Interaction read: records=${newInteractions.length}`);
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.error(`Transcript scan error: ${detail}`);
    } finally {
      transcriptScanRunning = false;
    }
  };

  let status: ApiStatus = {
    lastRefreshAt: null,
    errors: [],
    projectCount: 0,
  };

  let refreshRunning = false;
  let refreshPending = false;
  let refreshPendingForce = false;
  const refreshWaiters: Array<() => void> = [];
  // watcher はこの下の初期リフレッシュのあとに作るので、それまでは undefined。
  let watchedProjectsSync: WatchedProjectsSync | undefined;

  const runRefresh = async (force = false): Promise<void> => {
    if (refreshRunning) {
      refreshPending = true;
      if (force) {
        refreshPendingForce = true;
      }

      return new Promise<void>((resolve) => {
        refreshWaiters.push(resolve);
      });
    }

    refreshRunning = true;

    try {
      let nextForce = force;

      do {
        refreshPending = false;
        const useForce = nextForce;
        nextForce = false;

        const result = await refreshProjects(
          {
            discovery,
            repository,
            fingerprinter,
            cache,
            now: () => new Date(),
            humanDecisions,
          },
          { force: useForce },
        );

        status = updateStatusFromResult(cache, result, new Date());

        // Only announce a change when something actually changed. `bd --readonly`
        // still touches .beads/last-touched, so every refresh re-triggers the
        // watcher; without this guard each real change would emit a second,
        // empty board.changed event (refreshed=[] reused=all) to every client.
        if (result.refreshed.length > 0 || result.removed.length > 0) {
          events.publish({
            name: 'board.changed',
            data: {
              refreshed: result.refreshed,
              reused: result.reused,
              removed: result.removed,
            },
          });
        }

        if (refreshPending) {
          nextForce = refreshPendingForce;
          refreshPendingForce = false;
        }
      } while (refreshPending);

      const cacheEntries = cache.listProjects();
      const refreshAt = new Date();
      const notificationSnapshot = computeBoardNotificationSnapshot(
        boardSnapshotInputFromCache(cacheEntries),
        refreshAt,
      );
      for (const payload of boardNotificationPublisher.collectTransitions(
        cacheEntries,
        notificationSnapshot,
        refreshAt,
      )) {
        events.publish({
          name: 'notification',
          data: payload,
        });
      }

      // discovery で増えた/消えたプロジェクトを監視対象に反映する。これが無いと
      // 起動後に現れたプロジェクトは定期リフレッシュ間隔ぶん遅れてしか画面に出ない。
      try {
        await watchedProjectsSync?.sync();
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        console.error(`Project watcher update error: ${detail}`);
      }
    } finally {
      refreshRunning = false;
      const waiters = refreshWaiters.splice(0);
      for (const resolve of waiters) {
        resolve();
      }
    }
  };

  const initialResult = await runInitialRefresh({
    discovery,
    repository,
    fingerprinter,
    cache,
    now: () => new Date(),
    humanDecisions,
  });

  console.log(
    `Initial refresh: refreshed=${initialResult.refreshed.length} reused=${initialResult.reused.length} removed=${initialResult.removed.length}`,
  );

  for (const error of initialResult.errors) {
    console.error(
      `Refresh error [${error.kind}] project=${error.projectId}: ${error.detail}`,
    );
  }

  status = updateStatusFromResult(
    cache,
    initialResult,
    new Date(),
  );

  await refreshSessions();
  console.log(
    `Initial sessions: total=${sessions.length} alive=${sessions.filter((session) => session.alive).length}`,
  );

  const initialCacheEntries = cache.listProjects();
  boardNotificationPublisher.seedSnapshot(
    computeBoardNotificationSnapshot(
      boardSnapshotInputFromCache(initialCacheEntries),
      new Date(),
    ),
  );

  const initialCfdSnapshot = recordCfdSnapshot(cache, new Date());
  console.log(
    `Initial CFD snapshot: recorded=${initialCfdSnapshot.recorded} date=${initialCfdSnapshot.snapshotDate}`,
  );

  let transcriptIntervalTimer: ReturnType<typeof setInterval> | undefined;
  let cfdSnapshotIntervalTimer: ReturnType<typeof setInterval> | undefined;
  let aiQuotaAlertIntervalTimer: ReturnType<typeof setInterval> | undefined;

  if (transcriptIntervalMs > 0) {
    try {
      const initialLinks = await transcriptScanner.scan({
        projects: cache.listProjects().map((entry) => entry.project),
        knownIdsByProject: new Map(
          cache.listProjects().map((entry) => [
            entry.project.id,
            new Set(entry.tickets.map((ticket) => ticket.id)),
          ]),
        ),
        now: new Date(),
      });
      mergeTranscriptLinks(initialLinks);
      console.log(`Initial transcript scan: links=${initialLinks.length}`);

      const initialInteractions = await interactionReader.read({
        projects: cache.listProjects().map((entry) => entry.project),
      });
      console.log(`Initial interaction read: records=${initialInteractions.length}`);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.error(`Initial transcript scan error: ${detail}`);
    }

    transcriptIntervalTimer = setInterval(() => {
      void runTranscriptScan();
    }, transcriptIntervalMs);
  }

  const watcher = createChokidarProjectWatcher();
  const initialWatchedProjects = cache
    .listProjects()
    .map((entry) => entry.project);
  const watchHandle = await watcher.watch(initialWatchedProjects, () => {
    void runRefresh(false);
  });
  watchedProjectsSync = createWatchedProjectsSync({
    cache,
    handle: watchHandle,
    initialProjects: initialWatchedProjects,
  });

  const intervalTimer = setInterval(() => {
    void runRefresh(true);
  }, refreshIntervalMs);

  const sessionIntervalTimer = setInterval(() => {
    void refreshSessions();
  }, sessionIntervalMs);

  if (cfdSnapshotIntervalMs > 0) {
    cfdSnapshotIntervalTimer = setInterval(() => {
      const result = recordCfdSnapshot(cache, new Date());
      if (result.recorded) {
        console.log(`CFD snapshot recorded: date=${result.snapshotDate}`);
      }
    }, cfdSnapshotIntervalMs);
  }

  const reclaimScheduler = createReclaimScheduler({
    reclaimer: leaseReclaimer,
    listProjects: () => cache.listProjects().map((entry) => entry.project),
    config: {
      enabled: reclaimEnabled,
      intervalMs: reclaimIntervalMs,
      olderThan: reclaimOlderThan,
    },
    logError: (message) => {
      console.error(message);
    },
  });
  reclaimScheduler.start();
  if (reclaimEnabled) {
    console.log(
      `Lease reclaim: enabled (interval=${reclaimIntervalMs}ms older-than=${reclaimOlderThan})`,
    );
  } else {
    console.log('Lease reclaim: disabled');
  }

  const authMode = resolveAuthMode(process.env);
  const authUsername = envString('BDBOARD_AUTH_USER', 'bdboard');

  const tunnelLogMaxBytes = envInt('BDBOARD_TUNNEL_LOG_MAX_BYTES', 5 * 1024 * 1024);
  const tunnelProcess = createCloudflaredTunnel({ port, logMaxBytes: tunnelLogMaxBytes });
  const tunnelAccess = createTunnelAccessService({ now: () => new Date() });
  const tunnelInterruptions = createFileTunnelInterruptionStore(
    path.join(path.dirname(dbPath), 'tunnel-interruption.json'),
  );
  const tunnelService = createTunnelService({
    tunnel: tunnelProcess,
    now: () => new Date(),
    username: authUsername,
    // Math.random is not a CSPRNG: V8's generator leaks its internal state to
    // anyone who observes enough output, and this passphrase is handed out over
    // a public URL. randomInt draws from the same pool as the rest of node:crypto.
    generatePassword: () => generatePassphrase(() => randomInt(0, 2 ** 32) / 2 ** 32),
    access: tunnelAccess,
    interruptions: tunnelInterruptions,
  });

  try {
    const tunnelAvailable = await tunnelService.probeAvailability();
    if (tunnelAvailable) {
      console.log('Tunnel: available');
    } else {
      console.log('Tunnel: not available (cloudflared not found)');
    }
  } catch {
    console.log('Tunnel: not available (cloudflared not found)');
  }

  if (authMode.kind === 'enabled') {
    console.log('Basic auth: enabled');
  } else if (authMode.kind === 'disabled-explicitly') {
    console.log('Basic auth: DISABLED explicitly (BDBOARD_AUTH_DISABLED)');
  } else {
    console.log(
      'Basic auth: not configured; all requests will be rejected with 503. Set BDBOARD_AUTH_USER and BDBOARD_AUTH_PASSWORD.',
    );
  }

  // トンネル経由の書き込み開放(bdboard-9rz)。判定は write-guard 1 箇所に集約して
  // あるので、ここでは材料(パスワード強度・セッション Cookie の有効性)を渡すだけ。
  // bdboard-cu4 でチャットも同じ材料を共有する(片方だけ緩むのを構造的に防ぐ)。
  const writeAccess = {
    isTunnelWriteAllowed: () => tunnelService.isWriteAllowed(),
    hasTunnelSession: createSessionValidator(tunnelAccess),
  };

  const inner = createApiRoutes({
    cache,
    now: () => new Date(),
    getStatus: () => status,
    refresh: () => runRefresh(true),
    events,
    sessions: () => sessions,
    links: () => listTranscriptLinks(),
    commentReader,
    prStatusReader,
    processScanner,
    humanDecisions,
    syncHealthReader,
    worktreeScanner,
    issueWriter,
    dependencyWriter,
    sessionLinkWriter,
    sessionLinkReader,
    sessionTail: sessionTailReader,
    writeAccess,
    leaseReader,
    mergeSlotReader,
    reclaimScheduler,
    getBoardThresholds: async () =>
      resolveBoardThresholds(await boardThresholdsConfigStore.read()),
  });

  const app = new Hono();
  const repoRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
  );
  mountSecurityMiddleware(app, {
    authMode,
    access: tunnelAccess,
    getExtraCredentials: () => tunnelService.getCredentials(),
  });
  app.use('*', createCompressionMiddleware());
  app.route('/', inner);

  const harnessPacksRoot = path.join(repoRoot, 'harness', 'packs');
  const packRegistry = createFsPackRegistry(harnessPacksRoot);
  const harnessInjector = createFsHarnessInjector({ packsRoot: harnessPacksRoot });
  app.route(
    '/',
    createHarnessRoutes({
      cache,
      registry: packRegistry,
      injector: harnessInjector,
      writeAccess,
    }),
  );

  app.route(
    '/',
    createScanRootsRoutes({
      store: scanRootsConfigStore,
      writeAccess,
      isEnvOverridden: isScanRootsEnvOverridden,
      envScanRoots: isScanRootsEnvOverridden ? envScanRootsList : undefined,
      resolveDefaultScanRoots: () => resolveDefaultScanRoots(fsPort),
    }),
  );

  app.route(
    '/',
    createBoardThresholdsRoutes({
      store: boardThresholdsConfigStore,
      writeAccess,
    }),
  );

  app.route(
    '/',
    createAiQuotaAlertRoutes({
      store: aiQuotaAlertConfigStore,
      writeAccess,
    }),
  );

  app.route('/', createTunnelRoutes({ tunnelService, access: tunnelAccess }));

  const aiQuotaDisabled = envBool('BDBOARD_AI_QUOTA_DISABLED');
  if (!aiQuotaDisabled) {
    const aiQuotaSource = createNodeAiQuotaSource(commandRunner, {
      command: envString('BDBOARD_AI_QUOTA_PATH', 'ai-quota'),
      timeoutMs: envInt('BDBOARD_AI_QUOTA_TIMEOUT_MS', 30_000),
    });
    const aiQuotaService = createAiQuotaService({
      source: aiQuotaSource,
      now: () => new Date(),
      ttlMs: envInt('BDBOARD_AI_QUOTA_CACHE_MS', 5 * 60_000),
    });
    app.route('/', createAiQuotaRoutes({ aiQuotaService }));

    const aiQuotaThresholdPublisher = createAiQuotaThresholdPublisher();
    const checkAiQuotaThresholds = async (): Promise<void> => {
      try {
        const state = await aiQuotaService.getSnapshot();
        if (state.kind !== 'ok') {
          return;
        }
        const config = await aiQuotaAlertConfigStore.read();
        const thresholdPercent = resolveAiQuotaAlertThresholdPercent(config);
        const occurredAt = new Date();
        for (const payload of aiQuotaThresholdPublisher.collectBreaches(
          state.providers,
          thresholdPercent,
          occurredAt,
        )) {
          events.publish({ name: 'notification', data: payload });
        }
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        console.error(`AI quota threshold check error: ${detail}`);
      }
    };
    void checkAiQuotaThresholds();
    aiQuotaAlertIntervalTimer = setInterval(
      () => void checkAiQuotaThresholds(),
      envInt('BDBOARD_AI_QUOTA_ALERT_INTERVAL_MS', 60_000),
    );

    console.log('AI quota widget: enabled');
  } else {
    console.log('AI quota widget: disabled');
  }

  const chatDisabled = envBool('BDBOARD_CHAT_DISABLED');
  if (!chatDisabled) {
    // 登録配線そのもの(claude 常時登録 / codex・cursor は opt-in 時のみ)は
    // chat-agent-registry-builder.ts に切り出してユニットテスト可能にしてある
    // (bdboard-l1t.4 SF6, cursor は bdboard-l1t.5)。ここでは env を渡して呼ぶだけにする。
    const { registry: chatAgentRegistry, codexEnabled, cursorEnabled, agyEnabled } = buildChatAgentRegistry(
      process.env,
      commandRunner,
      streamingCommandRunner,
    );
    if (codexEnabled) {
      console.log('Chat: codex adapter enabled via BDBOARD_CHAT_AGENTS opt-in (bdboard-l1t.4)');
    }
    if (cursorEnabled) {
      console.log('Chat: cursor adapter enabled via BDBOARD_CHAT_AGENTS opt-in (bdboard-l1t.5)');
    }
    if (agyEnabled) {
      console.log('Chat: agy adapter enabled via BDBOARD_CHAT_AGENTS opt-in (bdboard-l1t.6)');
    }
    const chatAgent = chatAgentRegistry.defaultAgent();
    if (chatAgent === undefined) {
      throw new Error('chat agent registry has no registered agents');
    }
    const chatSessionRepository = createSqliteChatSessionRepository(dbPath);
    const chatMessageRepository = createSqliteChatMessageRepository(dbPath);
    const chatStore = createChatSessionStore({ repository: chatSessionRepository });
    const chatPerMinute = envInt(
      'BDBOARD_CHAT_TUNNEL_RATE_PER_MINUTE',
      DEFAULT_CHAT_RATE_LIMIT_PER_MINUTE,
    );
    const chatPerDay = envInt(
      'BDBOARD_CHAT_TUNNEL_LIMIT_PER_DAY',
      DEFAULT_CHAT_RATE_LIMIT_PER_DAY,
    );
    const chatDefaultWeight = envFloat(
      'BDBOARD_CHAT_RATE_WEIGHT_DEFAULT',
      DEFAULT_CHAT_RATE_LIMIT_WEIGHT,
    );
    app.route(
      '/',
      createChatRoutes({
        cache,
        agents: chatAgentRegistry,
        store: chatStore,
        sessionDiscovery: chatSessionDiscovery,
        messages: chatMessageRepository,
        writeAccess,
        rateLimit: {
          perMinute: chatPerMinute,
          perDay: chatPerDay,
          defaultWeight: chatDefaultWeight,
        },
      }),
    );
    console.log(
      'Chat: enabled (local, or a tunnel session from the QR when the tunnel password is strong)',
    );
    const defaultAgentModels = chatAgentRegistry.defaultAgent()?.descriptor.models;
    const modelWeightsLog =
      defaultAgentModels !== undefined && defaultAgentModels.length > 0
        ? ` (${defaultAgentModels
            .map((entry) => `${entry.id} x${entry.weight ?? chatDefaultWeight}`)
            .join(', ')})`
        : '';
    console.log(
      `Chat rate limit (tunnel only): ${chatPerMinute}/min, ${chatPerDay}/day${modelWeightsLog}`,
    );
  } else {
    console.log('Chat: disabled');
  }

  const webDistDir = path.join(repoRoot, 'web', 'dist');

  const spaIndexPath = path.join(webDistDir, 'index.html');
  if (fs.existsSync(spaIndexPath)) {
    const relative = path.relative(process.cwd(), webDistDir);
    const staticRoot = (relative === '' ? '.' : relative)
      .split(path.sep)
      .join('/');
    const spaIndexHtml = fs.readFileSync(spaIndexPath, 'utf8');

    console.log(`Serving static web UI from ${webDistDir}`);

    app.use('/*', serveStatic({ root: staticRoot }));
    app.get('*', (c) => {
      if (c.req.path.startsWith('/api/') || c.req.path === '/api') {
        return c.notFound();
      }
      return c.html(spaIndexHtml);
    });
  } else {
    console.log('web/dist not found; serving API only');
  }

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
  const drain = createShutdownDrain({ watchHandle, tunnelService, cache });

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
    clearInterval(intervalTimer);
    clearInterval(sessionIntervalTimer);
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
