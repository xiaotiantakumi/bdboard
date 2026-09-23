import { Hono } from 'hono';
import { getHygieneIssues } from '../../application/board/get-hygiene-issues.js';
import { getPendingCommentAnchors } from '../../application/board/get-pending-comment-anchors.js';
import { getCloseEvidence } from '../../application/board/get-close-evidence.js';
import type { PrBadgeCommentCache } from '../../application/board/get-pr-badges.js';
import { scanGitLeftovers } from '../../application/board/scan-git-leftovers.js';
import { scanInFlightOverlaps } from '../../application/board/scan-in-flight-overlaps.js';
import { scanHarnessWorktreeLags } from '../../application/board/scan-harness-worktree-lags.js';
import { scanNonTicketHarnessWorktreeLags } from '../../application/board/scan-non-ticket-harness-worktree-lags.js';
import {
  checkNonTicketHarnessWorktrees,
  filterNonTicketWorktreesWithLiveSession,
  type NonTicketHarnessWorktreeLag,
} from '../../domain/non-ticket-harness-worktree.js';
import type { LeftoverCandidate } from '../../domain/git-worktree.js';
import { selectInFlightWorktrees, type InFlightOverlap } from '../../domain/in-flight-overlap.js';
import type {
  HarnessWorktreeLag,
  HeartbeatLoopCandidate,
} from '../../domain/hygiene.js';
import { resolveHygieneThresholds } from '../../domain/hygiene-thresholds.js';
import { toHygieneIssueDto, toNonTicketHarnessWorktreeWarningDto } from './dto.js';
import { parseProjectIds, type InFlightOverlapMemo } from './api-route-shared.js';
import type { ApiDeps } from './routes.js';

// bdboard-sso1.61: hygiene-routes.ts (旧284行、5ルートが同居) の分割で
// GET /api/hygiene をここへ切り出した (move only, 挙動変更ゼロ)。close 証拠
// チェックが読むコメント本文は PR バッジ走査 (GET /api/pr-links,
// pr-links-routes.ts) の結果を再利用する (bdboard-pkr6.16) ため、共有キャッシュ
// (prBadgeCommentCache) を合成層 (hygiene-routes.ts) から明示引数で受け取る
// (harness-routes.ts 分割 bdboard-sso1.56 と同じ方針)。

export interface HygieneStatusRoutesParams {
  readonly prBadgeCommentCache: PrBadgeCommentCache;
}

export function createHygieneStatusRoutes(
  deps: ApiDeps,
  memo: InFlightOverlapMemo,
  { prBadgeCommentCache }: HygieneStatusRoutesParams,
): Hono {
  const app = new Hono();
  const { memoizedInFlightOverlaps } = memo;

  app.get('/api/hygiene', async (c) => {
    const projectIds = parseProjectIds(c.req.query('projects'));

    let leftoverCandidates: readonly LeftoverCandidate[] | undefined;
    let inFlightOverlaps: readonly InFlightOverlap[] | undefined;
    let harnessWorktreeLags: readonly HarnessWorktreeLag[] | undefined;
    let nonTicketHarnessWorktreeLags: readonly NonTicketHarnessWorktreeLag[] | undefined;
    let heartbeatLoops: readonly HeartbeatLoopCandidate[] | undefined;
    if (deps.worktreeScanner !== undefined) {
      let entries = deps.cache.listProjects();
      if (projectIds !== undefined) {
        const filterSet = new Set(projectIds);
        entries = entries.filter((entry) => filterSet.has(entry.project.id));
      }
      const projects = entries.map((entry) => entry.project);
      const leftoverScan = await scanGitLeftovers(projects, deps.worktreeScanner);
      leftoverCandidates = leftoverScan.candidates;
      // bd/<id> に紐づかない worktree (feature/* 等)。同じ snapshot から拾うので
      // git 呼び出しは増えない (bdboard-wadg)。生存セッションの cwd がその worktree の
      // 内側に無いものは、放棄済みと見て以降の測定・警告の対象から外す (bdboard-cjsa)。
      const nonTicketWorktrees = filterNonTicketWorktreesWithLiveSession(
        leftoverScan.nonTicketWorktrees,
        deps.sessions?.() ?? [],
      );

      // merged_leftover と同じ worktree 一覧を使い回す。closed のものはあちらが、
      // まだ closed でないものはこちらが見る (git worktree list は 1 回で済む)。
      const inFlight = selectInFlightWorktrees(
        leftoverCandidates,
        entries.flatMap((entry) => entry.tickets),
      );
      const scanner = deps.worktreeScanner;
      inFlightOverlaps = await memoizedInFlightOverlaps(entries, () =>
        scanInFlightOverlaps(inFlight, scanner),
      );
      // 同じ inFlight 一覧を使い回して「ハーネスが凍っている worktree」も測る
      // (bdboard-tdua)。scanner が遅れを測れない構成なら空配列が返る。
      const inProgressWorktreeKeys = new Set(
        entries.flatMap((entry) =>
          entry.tickets
            .filter((ticket) => ticket.status === 'in_progress')
            .map((ticket) => `${entry.project.id}\0${ticket.id}`),
        ),
      );
      const isMeasured = (worktree: { projectId: string; ticketId: string }): boolean =>
        inProgressWorktreeKeys.has(`${worktree.projectId}\0${worktree.ticketId}`);
      // 遅れの基準 ref を検証コントラクトの mainBranch に合わせる (bdboard-pkr6.19)。読むのは
      // 実際に測るプロジェクトだけ。読めなければ scanner が既定の候補順で測る。
      const mainBranchesByProject = new Map<string, string>();
      const getMainBranch = deps.getProjectMainBranch;
      if (
        getMainBranch !== undefined &&
        scanner.countHarnessCommitsBehindDefaultBranch !== undefined
      ) {
        const rootPathById = new Map(projects.map((project) => [project.id, project.rootPath]));
        const measuredProjectIds = new Set(
          inFlight.filter(isMeasured).map((worktree) => worktree.projectId),
        );
        // 非チケット worktree はチケットの in_progress で絞れないので、生存セッションが
        // あるもの (filterNonTicketWorktreesWithLiveSession 済み) はすべて測る (bdboard-cjsa)。
        for (const worktree of nonTicketWorktrees) {
          measuredProjectIds.add(worktree.projectId);
        }
        await Promise.all(
          [...measuredProjectIds].map(async (projectId) => {
            const rootPath = rootPathById.get(projectId);
            if (rootPath === undefined) {
              return;
            }
            try {
              const mainBranch = await getMainBranch(rootPath);
              if (mainBranch !== undefined) {
                mainBranchesByProject.set(projectId, mainBranch);
              }
            } catch {
              // 既定の候補順で測る。1 プロジェクトの失敗で盤面を落とさない。
            }
          }),
        );
      }
      harnessWorktreeLags = await scanHarnessWorktreeLags(inFlight, scanner, {
        shouldMeasure: isMeasured,
        resolveMainBranch: (projectId) => mainBranchesByProject.get(projectId),
      });
      nonTicketHarnessWorktreeLags = await scanNonTicketHarnessWorktreeLags(
        nonTicketWorktrees,
        scanner,
        { resolveMainBranch: (projectId) => mainBranchesByProject.get(projectId) },
      );
    }

    // 確認待ちの放置判定は最終コメント日時も見る (bdboard-19db)。bd の updated_at は
    // コメントで動かないので、これが無いとコメントで議論が続いているチケットまで
    // 「放置」に出る。引くのは確認待ちのチケットだけなので件数はひと桁。
    const thresholds = await deps.getHygieneThresholds?.();
    const now = deps.now();
    const closedWithoutEvidenceWindowMs =
      thresholds?.closedWithoutEvidenceWindowMs ??
      resolveHygieneThresholds().closedWithoutEvidenceWindowMs;

    let pendingCommentAnchors: ReadonlyMap<string, Date> | undefined;
    let closeEvidenceKeys: ReadonlySet<string> | undefined;
    let closeEvidenceUnknownKeys: ReadonlySet<string> | undefined;
    let closeEvidenceStatus: { unknownCount: number } | null = null;
    const closeEvidenceAvailable =
      deps.commentReader !== undefined && deps.prStatusReader !== undefined;
    if (deps.commentReader !== undefined) {
      pendingCommentAnchors = await getPendingCommentAnchors(
        deps.cache,
        deps.commentReader,
        projectIds !== undefined ? { projectIds } : undefined,
      );
      // close 証拠チェックもコメント本文が要る (bdboard-pkr6.8)。bd comments は高いので、
      // PR バッジ用走査 (prBadgeCommentCache) の結果を再利用し、ここでは新規フェッチしない
      // (bdboard-pkr6.16)。未スキャン分は unknownKeys として返り、未確認は検出しない。
      const closeEvidence = await getCloseEvidence(
        deps.cache,
        now,
        closedWithoutEvidenceWindowMs,
        {
          ...(projectIds !== undefined ? { projectIds } : {}),
          sharedCommentCache: prBadgeCommentCache,
        },
      );
      closeEvidenceKeys = closeEvidence.evidenceKeys;
      closeEvidenceUnknownKeys = closeEvidence.unknownKeys;
      closeEvidenceStatus = { unknownCount: closeEvidence.unknownKeys.size };
    }

    const listLoops = deps.processScanner?.listHeartbeatLoops;
    if (deps.processScanner !== undefined && listLoops !== undefined) {
      try {
        heartbeatLoops = (await listLoops.call(deps.processScanner)).map((loop) => ({
          pid: loop.pid,
          commandLine: loop.commandLine,
          ...(loop.sessionPid !== undefined ? { sessionPid: loop.sessionPid } : {}),
          ...(loop.sessionAlive !== undefined ? { sessionAlive: loop.sessionAlive } : {}),
          ...(loop.lstart !== undefined ? { startedAt: loop.lstart } : {}),
        }));
      } catch {
        heartbeatLoops = undefined;
      }
    }

    const issues = getHygieneIssues(deps.cache, now, {
      ...(projectIds !== undefined ? { projectIds } : {}),
      ...(pendingCommentAnchors !== undefined ? { pendingCommentAnchors } : {}),
      ...(closeEvidenceKeys !== undefined ? { closeEvidenceKeys } : {}),
      ...(closeEvidenceUnknownKeys !== undefined && closeEvidenceUnknownKeys.size > 0
        ? { closeEvidenceUnknownKeys }
        : {}),
      closeEvidenceAvailable,
      ...(leftoverCandidates !== undefined ? { leftoverCandidates } : {}),
      ...(heartbeatLoops !== undefined ? { heartbeatLoops } : {}),
      ...(inFlightOverlaps !== undefined ? { inFlightOverlaps } : {}),
      ...(harnessWorktreeLags !== undefined ? { harnessWorktreeLags } : {}),
      ...(thresholds !== undefined ? { thresholds } : {}),
    });
    const nonTicketHarnessWorktrees = checkNonTicketHarnessWorktrees(
      nonTicketHarnessWorktreeLags ?? [],
    );

    return c.json({
      issues: issues.map(toHygieneIssueDto),
      closeEvidence: closeEvidenceStatus,
      nonTicketHarnessWorktrees: nonTicketHarnessWorktrees.map(
        toNonTicketHarnessWorktreeWarningDto,
      ),
    });
  });

  return app;
}
