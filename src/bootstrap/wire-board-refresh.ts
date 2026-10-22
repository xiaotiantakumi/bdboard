/**
 * bdboard-sso1.14: src/main.ts (composition root) からプロジェクト discovery・
 * リフレッシュ (coalescing 込み)・ファイル watcher の組み立てを
 * 切り出したもの (move only, 挙動変更ゼロ)。
 *
 * `status`/`watchedProjectsSync` は元実装でも「watcher 作成より前に runRefresh を
 * 握るクロージャが作られる」外側のミュータブル変数だった (refresh-runner.ts の
 * コメント参照)。ここでは同じパターンをこのファイル内に閉じ込め、呼び出し側
 * (main.ts) には `getStatus()` / 完成済み `watchedProjectsSync` だけを返す。
 */
import type { RefreshResult } from '../application/board/refresh-projects.js';
import { mergeStatusErrors } from '../application/board/merge-status-errors.js';
import { runInitialRefresh } from '../application/board/run-initial-refresh.js';
import { runUnattendedRefresh } from '../application/board/run-unattended-refresh.js';
import {
  boardSnapshotInputFromCache,
  createRefreshRunner,
} from '../application/board/refresh-runner.js';
import { createBoardNotificationPublisher } from '../application/board/board-notification-transitions.js';
import { createWatchedProjectsSync } from '../application/board/sync-watched-projects.js';
import type { WatchedProjectsSync } from '../application/board/sync-watched-projects.js';
import { computeBoardNotificationSnapshot } from '../domain/board-notifications.js';
import type { BoardCache } from '../application/ports/board-cache.js';
import type { IssueRepository } from '../application/ports/issue-repository.js';
import type { HumanDecisionsPort } from '../application/ports/human-decisions.js';
import type { EventHub } from '../interface/sse/event-hub.js';
import type { ApiStatus } from '../interface/http/routes.js';
import {
  createBeadsFingerprinter,
  createChokidarProjectWatcher,
  createFsProjectDiscovery,
  NodeFileSystem,
} from '../infrastructure/index.js';
import type { CommandRunner } from '../application/ports/command-runner.js';
import type { ScanRootsConfigPort } from '../application/ports/scan-roots-config.js';
import { readProjectRefs } from '../application/board/read-cached-projects.js';
import { createRefreshResultObserver } from '../application/board/refresh-result-observer.js';
import type { Project } from '../domain/project.js';

function updateStatusFromResult(
  cache: BoardCache,
  result: RefreshResult,
  refreshedAt: Date,
  previous: ApiStatus,
  onlyProjectIds?: readonly string[],
): ApiStatus {
  return {
    lastRefreshAt: refreshedAt,
    // bdboard-o1e5: 一部のプロジェクトだけの更新では、対象外プロジェクトの既存エラーを残す。
    errors: mergeStatusErrors(previous.errors, result.errors, result.removed, onlyProjectIds),
    projectCount: cache.listProjects().length,
  };
}

export interface WireBoardRefreshDeps {
  readonly env: NodeJS.ProcessEnv;
  readonly fsPort: InstanceType<typeof NodeFileSystem>;
  readonly commandRunner: CommandRunner;
  readonly scanRootsConfigStore: ScanRootsConfigPort;
  readonly repository: IssueRepository;
  readonly cache: BoardCache;
  readonly humanDecisions: HumanDecisionsPort;
  readonly events: EventHub;
  readonly refreshIntervalMs: number;
  readonly log?: (message: string) => void;
  readonly logError?: (message: string) => void;
  readonly onRefreshResult?: (result: RefreshResult, projects: readonly Project[]) => void;
}

/**
 * main() の discovery + refreshRunner + 初期リフレッシュ +
 * watcher + refresh インターバルを、元のコードと同じ順序でまとめて行う。
 * `sessionDiscoverySupported ? sessionLivenessTracker.refresh() ...` (board-sessions
 * 側) は初期リフレッシュのログの直後・通知スナップショット seed の直前に走る
 * (main.ts 側で挟む — このファイルの対象外)。
 */
export async function wireBoardRefresh(deps: WireBoardRefreshDeps) {
  const log = deps.log ?? console.log;
  const logError = deps.logError ?? console.error;

  const scanRootsRaw = deps.env.BDBOARD_SCAN_ROOTS;
  const isScanRootsEnvOverridden = scanRootsRaw !== undefined && scanRootsRaw !== '';
  const envScanRootsList = (scanRootsRaw ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  const scannedDiscovery = isScanRootsEnvOverridden
    ? createFsProjectDiscovery(
        { scanRoots: envScanRootsList },
        { fs: deps.fsPort, commandRunner: deps.commandRunner },
      )
    : createFsProjectDiscovery(undefined, {
        fs: deps.fsPort,
        commandRunner: deps.commandRunner,
        scanRootsConfigStore: deps.scanRootsConfigStore,
      });
  const refreshObserver = createRefreshResultObserver({
    discovery: scannedDiscovery, cache: deps.cache, onResult: deps.onRefreshResult, logError,
  });
  const discovery = refreshObserver.discovery;

  const fingerprinter = createBeadsFingerprinter(deps.fsPort);
  const boardNotificationPublisher = createBoardNotificationPublisher();

  let status: ApiStatus = { lastRefreshAt: null, errors: [], projectCount: 0 };
  // watcher はこの下の初期リフレッシュのあとに作るので、それまでは undefined。
  let watchedProjectsSync: WatchedProjectsSync | undefined;

  // bdboard-sso1.9: runRefresh の合流(coalescing)状態machine (旧 refreshRunning /
  // pendingRefresh / refreshWaiters / mergePendingRefresh 一式) は
  // application/board/refresh-runner.ts へ移動 (move only)。
  const refreshRunner = createRefreshRunner({
    discovery,
    repository: deps.repository,
    fingerprinter,
    cache: deps.cache,
    now: () => new Date(),
    humanDecisions: deps.humanDecisions,
    boardNotificationPublisher,
    publishBoardChanged: (data) => {
      deps.events.publish({ name: 'board.changed', data });
    },
    publishNotification: (payload) => {
      deps.events.publish({ name: 'notification', data: payload });
    },
    getWatchedProjectsSync: () => watchedProjectsSync,
    onResult: (result, refreshedAt, onlyProjectIds) => {
      status = updateStatusFromResult(deps.cache, result, refreshedAt, status, onlyProjectIds);
      refreshObserver.observe(result);
    },
  });
  const runRefresh = (force = false, onlyProjectIds?: readonly string[]): Promise<void> =>
    refreshRunner.run(force, onlyProjectIds);

  const initialResult = await runInitialRefresh({
    discovery,
    repository: deps.repository,
    fingerprinter,
    cache: deps.cache,
    now: () => new Date(),
    humanDecisions: deps.humanDecisions,
  });

  log(
    `Initial refresh: refreshed=${initialResult.refreshed.length} reused=${initialResult.reused.length} removed=${initialResult.removed.length}`,
  );
  for (const error of initialResult.errors) {
    logError(`Refresh error [${error.kind}] project=${error.projectId}: ${error.detail}`);
  }
  status = updateStatusFromResult(deps.cache, initialResult, new Date(), status);
  refreshObserver.observe(initialResult);

  return {
    discovery,
    boardNotificationPublisher,
    runRefresh,
    getStatus: (): ApiStatus => status,
    isScanRootsEnvOverridden,
    envScanRootsList,
    /** 通知スナップショットの seed。sessions の初期取得の直後に呼ぶ。 */
    finishInitialization: (): void => {
      const initialCacheEntries = deps.cache.listProjects();
      boardNotificationPublisher.seedSnapshot(
        computeBoardNotificationSnapshot(
          boardSnapshotInputFromCache(initialCacheEntries),
          new Date(),
        ),
      );
    },
    /** watcher 作成 + インターバル起動一式。sessions/transcript の初期処理の後に main.ts が呼ぶ。 */
    startWatchAndIntervals: async () => {
      const watcher = createChokidarProjectWatcher();
      const initialWatchedProjects = readProjectRefs(deps.cache);
      const watchHandle = await watcher.watch(initialWatchedProjects, () => {
        void runUnattendedRefresh({ refresh: () => runRefresh(false) });
      });
      watchedProjectsSync = createWatchedProjectsSync({
        cache: deps.cache,
        handle: watchHandle,
        initialProjects: initialWatchedProjects,
      });

      const refreshIntervalTimer = setInterval(() => {
        void runUnattendedRefresh({ refresh: () => runRefresh(true) });
      }, deps.refreshIntervalMs);

      return { watchHandle, refreshIntervalTimer };
    },
  };
}

export type BoardRefreshServices = Awaited<ReturnType<typeof wireBoardRefresh>>;
