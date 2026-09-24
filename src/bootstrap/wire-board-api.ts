/**
 * bdboard-sso1.86: src/main.ts (composition root) からハーネス契約リーダー・
 * プロジェクト単位リフレッシュ・盤面 API ルーター (`inner`) の組み立てを
 * 切り出したもの (move only, 挙動変更ゼロ)。
 *
 * `harnessContractReader` は /api/hygiene (getProjectMainBranch) と harness routes
 * (wire-harness.ts) の両方が使う横断的な値のため、ここで作って main.ts 側の
 * wireHarness 呼び出しにもそのまま渡す。createApiRoutes より前で作らないと
 * クロージャが TDZ の前方参照になる (bdboard-pkr6.19) ため、この関数内でも
 * 元と同じ順序 (harnessContractReader → refreshProjectByRootPath → inner) を保つ。
 */
import path from 'node:path';
import type { ApplicationVersionProvider } from '../application/ports/application-version.js';
import type { BoardCache } from '../application/ports/board-cache.js';
import type { BoardThresholdsConfigPort } from '../application/ports/board-thresholds-config.js';
import type { CommentReader } from '../application/ports/comment-reader.js';
import type { DependencyWriterPort } from '../application/ports/dependency-writer.js';
import type { HumanDecisionsPort } from '../application/ports/human-decisions.js';
import type { HygieneThresholdsConfigPort } from '../application/ports/hygiene-thresholds-config.js';
import type { IssueWriterPort } from '../application/ports/issue-writer.js';
import type { LeaseReader } from '../application/ports/lease-reader.js';
import type { MergeSlotReader } from '../application/ports/merge-slot-reader.js';
import type { PrStatusReader } from '../application/ports/pr-status-reader.js';
import type { ProcessScanner } from '../application/ports/process-scanner.js';
import type { SessionLinkWriterPort } from '../application/ports/session-link-writer.js';
import type { WorktreeScanner } from '../application/ports/worktree-scanner.js';
import { PrBadgeStatusCache } from '../application/board/get-pr-badges.js';
import type { ReclaimScheduler } from '../application/lease/reclaim-scheduler.js';
import type { ReclaimHistory } from '../application/lease/reclaim-history.js';
import { readProjectMainBranch } from '../application/harness/get-project-harness-status.js';
import {
  createFsHarnessContractReader,
  createFilePrBadgeStatusStore,
} from '../infrastructure/index.js';
import type { EventHub } from '../interface/sse/event-hub.js';
import { buildApiDeps } from '../interface/http/build-api-deps.js';
import { createApiRoutes } from '../interface/http/routes.js';
import type { WriteGuardDeps } from '../interface/http/write-guard.js';
import type { BoardRefreshServices } from './wire-board-refresh.js';
import type { BoardSessionServices } from './wire-board-sessions.js';

export interface WireBoardApiDeps {
  readonly cache: BoardCache;
  readonly applicationVersion: ApplicationVersionProvider;
  readonly instanceNonce: string | undefined;
  readonly boardRefreshServices: Pick<BoardRefreshServices, 'getStatus' | 'runRefresh'>;
  readonly events: EventHub;
  readonly boardThresholdsConfigStore: BoardThresholdsConfigPort;
  readonly hygieneThresholdsConfigStore: HygieneThresholdsConfigPort;
  readonly boardSessionServices: Pick<
    BoardSessionServices,
    'sessionLivenessTracker' | 'transcriptLinkTracker' | 'sessionTailReader'
  >;
  readonly commentReader: CommentReader;
  readonly prStatusReader: PrStatusReader;
  readonly processScanner: ProcessScanner;
  readonly humanDecisions: HumanDecisionsPort;
  readonly worktreeScanner: WorktreeScanner;
  readonly issueWriter: IssueWriterPort;
  readonly dependencyWriter: DependencyWriterPort;
  readonly sessionLinkWriter: SessionLinkWriterPort;
  readonly writeAccess: WriteGuardDeps;
  readonly leaseReader: LeaseReader;
  readonly mergeSlotReader: MergeSlotReader;
  readonly reclaimScheduler: ReclaimScheduler;
  readonly reclaimHistory: ReclaimHistory;
  /** PR バッジ terminal エントリの永続化先を決めるための board cache DB パス (bdboard-ye2p)。 */
  readonly dbPath: string;
}

export function wireBoardApi(deps: WireBoardApiDeps) {
  // /api/hygiene (getProjectMainBranch) と harness routes の両方が使う。createApiRoutes
  // より前で作る — 後ろで宣言するとクロージャが TDZ の前方参照になる (bdboard-pkr6.19)。
  const harnessContractReader = createFsHarnessContractReader();

  // bdboard-ye2p: PR バッジ terminal エントリの永続化。tunnel-interruption-store.ts
  // (wire-tunnel.ts) と同じ方針で dbPath (既定 ~/.bdboard/cache.db, BDBOARD_DB で
  // 上書き可) の隣に置く — 一時サーバー (別ポート・別 BDBOARD_DB) が常駐サーバーの
  // ファイルと衝突しないための分離を追加コード無しで得るため。読み書き失敗・
  // 破損ファイルはストア/キャッシュ双方で握りつぶし、都度取得に劣化するだけ。
  const prBadgeStatusStore = createFilePrBadgeStatusStore(
    path.join(path.dirname(deps.dbPath), 'pr-badge-status-cache.json'),
  );
  const prBadgeStatusCache = new PrBadgeStatusCache({
    initialEntries: prBadgeStatusStore.read(),
    onPersistableChange: () => {
      prBadgeStatusStore.write(prBadgeStatusCache.getTerminalEntries());
    },
  });

  const refreshProjectByRootPath = async (rootPath: string): Promise<void> => {
    const projectId = deps.cache
      .listProjects()
      .find((entry) => entry.project.rootPath === rootPath)?.project.id;
    // キャッシュに無い rootPath は絞り込みようがないので、安全側に倒して
    // 従来どおり全体を強制リフレッシュする。
    await deps.boardRefreshServices.runRefresh(
      true,
      projectId === undefined ? undefined : [projectId],
    );
  };

  const inner = createApiRoutes(
    buildApiDeps({
      cache: deps.cache,
      applicationVersion: deps.applicationVersion,
      instanceNonce: deps.instanceNonce,
      now: () => new Date(),
      getStatus: deps.boardRefreshServices.getStatus,
      refresh: () => deps.boardRefreshServices.runRefresh(true),
      refreshProjectByRootPath,
      events: deps.events,
      boardThresholdsConfigStore: deps.boardThresholdsConfigStore,
      hygieneThresholdsConfigStore: deps.hygieneThresholdsConfigStore,
      sessions: () => deps.boardSessionServices.sessionLivenessTracker.current(),
      links: () => deps.boardSessionServices.transcriptLinkTracker.list(),
      commentReader: deps.commentReader,
      prStatusReader: deps.prStatusReader,
      prBadgeStatusCache,
      processScanner: deps.processScanner,
      humanDecisions: deps.humanDecisions,
      worktreeScanner: deps.worktreeScanner,
      // 失敗時の握りつぶしは /api/hygiene 側 (既定の候補順へフォールバック) が持つ。
      getProjectMainBranch: (rootPath: string) =>
        readProjectMainBranch(harnessContractReader, rootPath),
      issueWriter: deps.issueWriter,
      dependencyWriter: deps.dependencyWriter,
      sessionLinkWriter: deps.sessionLinkWriter,
      sessionTail: deps.boardSessionServices.sessionTailReader,
      writeAccess: deps.writeAccess,
      leaseReader: deps.leaseReader,
      mergeSlotReader: deps.mergeSlotReader,
      reclaimScheduler: deps.reclaimScheduler,
      reclaimHistory: deps.reclaimHistory,
    }),
  );

  return { harnessContractReader, refreshProjectByRootPath, inner };
}
