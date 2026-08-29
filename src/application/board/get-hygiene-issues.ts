import type { LeftoverCandidate } from '../../domain/git-worktree.js';
import {
  checkHygiene,
  pendingDecisionKey,
  type HygieneIssue,
} from '../../domain/hygiene.js';
import type { BoardCache } from '../ports/board-cache.js';

export interface GetHygieneIssuesOptions {
  /** 指定されたIDのみ。未指定なら全部 */
  readonly projectIds?: readonly string[];
  readonly leftoverCandidates?: readonly LeftoverCandidate[];
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

  return checkHygiene(tickets, {
    now,
    pendingDecisionKeys,
    ...(options?.leftoverCandidates !== undefined
      ? { leftoverCandidates: options.leftoverCandidates }
      : {}),
  });
}
