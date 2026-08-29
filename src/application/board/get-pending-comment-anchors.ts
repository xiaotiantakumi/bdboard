import { pendingDecisionKey } from '../../domain/hygiene.js';
import type { Ticket } from '../../domain/ticket.js';
import { runWithConcurrencyLimit } from '../concurrency.js';
import type { BoardCache, CachedProject } from '../ports/board-cache.js';
import type { CommentReader } from '../ports/comment-reader.js';

export interface GetPendingCommentAnchorsOptions {
  /** 指定されたIDのみ。未指定なら全部 */
  readonly projectIds?: readonly string[];
}

// get-pr-badges.ts と同じ。bd-cli-issue-repository.ts の DEFAULT_CONCURRENCY に合わせる。
const COMMENT_FETCH_CONCURRENCY = 3;

interface FetchItem {
  readonly entry: CachedProject;
  readonly ticket: Ticket;
}

/**
 * 確認待ちチケットの最終コメント日時を集める (bdboard-19db)。
 *
 * bd の updated_at はコメントで動かない (実データ: bdboard-36w は updated_at 2026-08-16 に
 * 対しコメントが 08-18 と 08-29)。hygiene の stale_pending_decision がこれを見ないと、
 * コメントで議論が続いているチケットまで「放置」として出る。
 *
 * **確認待ちのチケットに限って引く。** 最終コメント日時は bd comments <id> を1件ずつ
 * 叩くしか取れず (bd 1.2.1 の bd comments は issue-id 必須で一括形式が無い)、全チケット分
 * 引くと refresh のたびに台帳全件ぶんのプロセス起動になる。確認待ちは常時ひと桁で、
 * この検知が必要なのもそこだけ。commentCount が 0 のチケットも落とす
 * (get-pr-badges.ts と同じ足切り)。
 *
 * 1件の失敗で全体を落とさない。取れなかったチケットはマップに載らず、hygiene 側は
 * updatedAt だけを見る従来の判定に落ちる — 誤検知が1件増えるだけで、画面が消えるより
 * ましという判断。
 */
export async function getPendingCommentAnchors(
  cache: BoardCache,
  commentReader: CommentReader,
  options?: GetPendingCommentAnchorsOptions,
): Promise<ReadonlyMap<string, Date>> {
  const projectIdFilter = options?.projectIds;
  let entries = cache.listProjects();

  if (projectIdFilter !== undefined) {
    const filterSet = new Set(projectIdFilter);
    entries = entries.filter((entry) => filterSet.has(entry.project.id));
  }

  const items: FetchItem[] = entries.flatMap((entry) => {
    const pendingIds = new Set(
      (entry.pendingDecisions ?? []).map((decision) => decision.id),
    );
    if (pendingIds.size === 0) {
      return [];
    }
    return entry.tickets
      .filter((ticket) => pendingIds.has(ticket.id) && ticket.commentCount > 0)
      .map((ticket) => ({ entry, ticket }));
  });

  const anchors = new Map<string, Date>();

  await runWithConcurrencyLimit(items, COMMENT_FETCH_CONCURRENCY, async ({ entry, ticket }) => {
    let comments;
    try {
      comments = await commentReader.listComments(entry.project.rootPath, ticket.id);
    } catch {
      return;
    }

    let latest: Date | undefined;
    for (const comment of comments) {
      const createdAt = comment.createdAt;
      if (!(createdAt instanceof Date) || !Number.isFinite(createdAt.getTime())) {
        continue;
      }
      if (latest === undefined || createdAt.getTime() > latest.getTime()) {
        latest = createdAt;
      }
    }

    if (latest !== undefined) {
      anchors.set(pendingDecisionKey(entry.project.id, ticket.id), latest);
    }
  });

  return anchors;
}
