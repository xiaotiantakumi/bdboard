import { getBoardTimeZone } from '../../config/board-timezone.js';
import type { LeftoverCandidate } from '../../domain/git-worktree.js';
import type { HeartbeatLoopCandidate } from '../../domain/hygiene.js';
import type { InFlightOverlap } from '../../domain/in-flight-overlap.js';
import {
  checkHygiene,
  pendingDecisionKey,
  type HygieneIssue,
  type HygieneThresholds,
} from '../../domain/hygiene.js';
import type { BoardCache } from '../ports/board-cache.js';

export interface GetHygieneIssuesOptions {
  /** 指定されたIDのみ。未指定なら全部 */
  readonly projectIds?: readonly string[];
  readonly leftoverCandidates?: readonly LeftoverCandidate[];
  /** 走査した bd heartbeat ループ (processScanner.listHeartbeatLoops の戻り)。 */
  readonly heartbeatLoops?: readonly HeartbeatLoopCandidate[];
  /** 着手中 worktree 同士のファイル重複 (scanInFlightOverlaps の戻り)。 */
  readonly inFlightOverlaps?: readonly InFlightOverlap[];
  /**
   * 確認待ちチケットの最終コメント日時 (getPendingCommentAnchors の戻り)。
   * bd を叩く必要があるのでここでは組み立てず、呼び出し側から受け取る。
   */
  readonly pendingCommentAnchors?: ReadonlyMap<string, Date>;
  /**
   * close 済みチケットで PR/検証コメントがあるキー集合 (getCloseEvidence の evidenceKeys)。
   * bd を叩く必要があるのでここでは組み立てず、呼び出し側から受け取る。
   */
  readonly closeEvidenceKeys?: ReadonlySet<string>;
  /**
   * コメント本文をまだ確認できていないチケット (getCloseEvidence の unknownKeys)。
   */
  readonly closeEvidenceUnknownKeys?: ReadonlySet<string>;
  /**
   * コメント本文を読む手段があるか。false なら closed_without_evidence の判定自体を
   * 行わない。getCloseEvidence を呼ばない構成 (commentReader 未設定) 向け。
   */
  readonly closeEvidenceAvailable?: boolean;
  readonly thresholds?: HygieneThresholds;
  readonly timeZone?: string;
}

export function getHygieneIssues(
  cache: BoardCache,
  now: Date,
  options?: GetHygieneIssuesOptions,
): readonly HygieneIssue[] {
  const projectIdFilter = options?.projectIds;
  let entries = cache.listProjects();

  if (projectIdFilter !== undefined) {
    const filterSet = new Set(projectIdFilter);
    entries = entries.filter((entry) => filterSet.has(entry.project.id));
  }

  const tickets = entries.flatMap((entry) => entry.tickets);

  // 確認待ちレーンは bd の human ラベル由来で、refreshProjects がキャッシュに
  // 載せた pendingDecisions がその原本 (get-board.ts の humanLabeledIdsFromCache と
  // 同じ出所)。ドメイン側は Ticket しか見ないので、ここで集めて渡す。
  //
  // 盤面は humanLabeledIdsFromCache を entry ごとに作るので、確認待ちの判定は
  // 常にそのプロジェクト内で閉じている。ここは全 entry のチケットを1本の配列に
  // 潰してから checkHygiene に渡すため、ID だけの集合にすると、同じIDのチケットを
  // 持つ2プロジェクトが同時にスコープへ入った瞬間に取り違える。projectId を
  // 前置したキーで持つ。
  const pendingDecisionKeys = new Set<string>(
    entries.flatMap((entry) =>
      (entry.pendingDecisions ?? []).map((decision) =>
        pendingDecisionKey(entry.project.id, decision.id),
      ),
    ),
  );

  const timeZone = options?.timeZone ?? getBoardTimeZone();

  return checkHygiene(tickets, {
    now,
    timeZone,
    pendingDecisionKeys,
    ...(options?.pendingCommentAnchors !== undefined
      ? { pendingCommentAnchors: options.pendingCommentAnchors }
      : {}),
    ...(options?.closeEvidenceKeys !== undefined
      ? { closeEvidenceKeys: options.closeEvidenceKeys }
      : {}),
    ...(options?.closeEvidenceUnknownKeys !== undefined
      ? { closeEvidenceUnknownKeys: options.closeEvidenceUnknownKeys }
      : {}),
    ...(options?.closeEvidenceAvailable !== undefined
      ? { closeEvidenceAvailable: options.closeEvidenceAvailable }
      : {}),
    ...(options?.thresholds !== undefined ? { thresholds: options.thresholds } : {}),
    ...(options?.leftoverCandidates !== undefined
      ? { leftoverCandidates: options.leftoverCandidates }
      : {}),
    ...(options?.heartbeatLoops !== undefined
      ? { heartbeatLoops: options.heartbeatLoops }
      : {}),
    ...(options?.inFlightOverlaps !== undefined
      ? { inFlightOverlaps: options.inFlightOverlaps }
      : {}),
  });
}
