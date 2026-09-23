/**
 * bdboard-sso1.86: src/main.ts (composition root) から起動時の盤面ライフサイクル
 * (discovery/refresh/セッション/transcript/reclaim の初期化と定期実行の kickoff) を
 * まとめて切り出したもの (move only, 挙動変更ゼロ)。
 *
 * 各ステップの相対順序 (プロセススキャナ → イベントハブ → セッションサービス →
 * board refresh → セッション初回取得 → 通知初期化 → transcript インターバル →
 * watcher/refresh インターバル → セッションインターバル → reclaim) は元の main() と
 * 完全に同じ順序で await する。中身は既存の wire-board-refresh.ts /
 * wire-board-sessions.ts / wire-board-reclaim.ts をそのまま呼ぶだけで、構築ロジック
 * 自体はここでは変えない。
 */
import type { BoardCache } from '../application/ports/board-cache.js';
import type { CommandRunner } from '../application/ports/command-runner.js';
import type { HumanDecisionsPort } from '../application/ports/human-decisions.js';
import type { IssueRepository } from '../application/ports/issue-repository.js';
import type { LeaseReader } from '../application/ports/lease-reader.js';
import type { LeaseReclaimer } from '../application/ports/lease-reclaimer.js';
import type { ScanRootsConfigPort } from '../application/ports/scan-roots-config.js';
import type { WorktreeScanner } from '../application/ports/worktree-scanner.js';
import type { PlatformSupport } from '../domain/platform-support.js';
import { createPsProcessScanner, NodeFileSystem } from '../infrastructure/index.js';
import { createEventHub } from '../interface/sse/event-hub.js';
import {
  createBoardSessionServices,
  runInitialSessionsFetch,
  startSessionInterval,
  startTranscriptInterval,
} from './wire-board-sessions.js';
import { wireBoardRefresh } from './wire-board-refresh.js';
import { wireBoardReclaim } from './wire-board-reclaim.js';

export interface WireBoardLifecycleDeps {
  readonly env: NodeJS.ProcessEnv;
  readonly fsPort: InstanceType<typeof NodeFileSystem>;
  readonly commandRunner: CommandRunner;
  readonly scanRootsConfigStore: ScanRootsConfigPort;
  readonly repository: IssueRepository;
  readonly cache: BoardCache;
  readonly humanDecisions: HumanDecisionsPort;
  readonly platformSupport: PlatformSupport;
  readonly sessionDiscoverySupported: boolean;
  readonly refreshIntervalMs: number;
  readonly sessionIntervalMs: number;
  readonly transcriptIntervalMs: number;
  readonly cfdSnapshotIntervalMs: number;
  readonly cfdSnapshotRetentionDays: number;
  readonly leaseReclaimer: LeaseReclaimer;
  readonly leaseReader: LeaseReader;
  readonly worktreeScanner: WorktreeScanner;
  readonly reclaimEnabled: boolean;
  readonly reclaimIntervalMs: number;
  readonly reclaimOlderThan: string;
}

export async function wireBoardLifecycle(deps: WireBoardLifecycleDeps) {
  const processScanner = createPsProcessScanner(deps.commandRunner);
  const events = createEventHub();

  const boardSessionServices = createBoardSessionServices({
    fsPort: deps.fsPort,
    cache: deps.cache,
    events,
  });

  const boardRefreshServices = await wireBoardRefresh({
    env: deps.env,
    fsPort: deps.fsPort,
    commandRunner: deps.commandRunner,
    scanRootsConfigStore: deps.scanRootsConfigStore,
    repository: deps.repository,
    cache: deps.cache,
    humanDecisions: deps.humanDecisions,
    events,
    refreshIntervalMs: deps.refreshIntervalMs,
    cfdSnapshotIntervalMs: deps.cfdSnapshotIntervalMs,
    cfdSnapshotRetentionDays: deps.cfdSnapshotRetentionDays,
  });

  await runInitialSessionsFetch(
    boardSessionServices,
    deps.platformSupport,
    deps.sessionDiscoverySupported,
  );

  boardRefreshServices.finishInitialization();

  const transcriptIntervalTimer = await startTranscriptInterval(boardSessionServices, {
    cache: deps.cache,
    transcriptIntervalMs: deps.transcriptIntervalMs,
  });

  const { watchHandle, refreshIntervalTimer, cfdSnapshotIntervalTimer } =
    await boardRefreshServices.startWatchAndIntervals();

  const sessionIntervalTimer = startSessionInterval(
    boardSessionServices,
    deps.sessionDiscoverySupported,
    deps.sessionIntervalMs,
  );

  const { reclaimScheduler, reclaimHistory } = wireBoardReclaim({
    leaseReclaimer: deps.leaseReclaimer,
    leaseReader: deps.leaseReader,
    worktreeScanner: deps.worktreeScanner,
    cache: deps.cache,
    reclaimEnabled: deps.reclaimEnabled,
    reclaimIntervalMs: deps.reclaimIntervalMs,
    reclaimOlderThan: deps.reclaimOlderThan,
  });

  return {
    processScanner,
    events,
    boardSessionServices,
    boardRefreshServices,
    transcriptIntervalTimer,
    watchHandle,
    refreshIntervalTimer,
    cfdSnapshotIntervalTimer,
    sessionIntervalTimer,
    reclaimScheduler,
    reclaimHistory,
  };
}
