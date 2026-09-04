import { pendingDecisionKey } from '../../domain/hygiene.js';
import type { Ticket } from '../../domain/ticket.js';
import { runWithConcurrencyLimit } from '../concurrency.js';
import type { BoardCache, CachedProject } from '../ports/board-cache.js';
import type { CommentReader } from '../ports/comment-reader.js';
import { describeFetchFailures, type FetchFailure } from './fetch-failure-log.js';

export interface GetCloseEvidenceKeysOptions {
  /** 指定されたIDのみ。未指定なら全部 */
  readonly projectIds?: readonly string[];
  /** 取得失敗の警告ログ。未指定なら console.warn (discover-projects と同じ注入流儀)。 */
  readonly logWarn?: (message: string) => void;
}

// get-pending-comment-anchors.ts / get-pr-badges.ts と同じ。bd-cli-issue-repository.ts の DEFAULT_CONCURRENCY に合わせる。
const COMMENT_FETCH_CONCURRENCY = 3;

const MERGE_SLOT_LABEL = 'gt:slot';

interface FetchItem {
  readonly entry: CachedProject;
  readonly ticket: Ticket;
}

function isExcludedFromCloseEvidenceFetch(ticket: Ticket): boolean {
  if (ticket.issueType === 'epic' || ticket.issueType === 'gate') {
    return true;
  }
  return ticket.labels?.includes(MERGE_SLOT_LABEL) ?? false;
}

function isValidClosedAt(closedAt: Date | undefined): closedAt is Date {
  return closedAt instanceof Date && Number.isFinite(closedAt.getTime());
}

function isWithinCloseEvidenceWindow(
  closedAt: Date,
  now: Date,
  windowMs: number,
): boolean {
  const elapsedMs = now.getTime() - closedAt.getTime();
  return elapsedMs >= 0 && elapsedMs <= windowMs;
}

function commentHasCloseEvidence(text: string): boolean {
  if (text.includes('PR:') || text.includes('PR：')) {
    return true;
  }
  if (text.includes('検証:') || text.includes('検証：')) {
    return true;
  }
  return false;
}

/**
 * close 済みチケットのコメントから PR/検証の記録があるかをキー集合で返す (bdboard-pkr6.8)。
 *
 * bd comments は issue-id 必須で1チケットずつプロセスを起動するしかなく、台帳全件を
 * 舐めると refresh のたびに数百プロセスになる。対象は **直近 window 内に close された
 * closed チケットで commentCount > 0 のものだけ** に絞る。epic / gate / gt:slot も
 * 検知対象外なのでここで除外し、無駄なフェッチをしない。
 *
 * **コメント本文は返り値に含めない。** キー集合だけに潰すのは、refresh ごとに本文を
 * 持ち回るとメモリと転送量が膨らむため (get-pending-comment-anchors が Date だけを
 * 返すのと同じ設計)。
 *
 * 1件の失敗で全体を落とさない。取れなかったチケットは集合に載らず、hygiene 側は
 * 「証拠なし」に倒れる — 誤検知が1件増えるだけで、画面が消えるよりましという判断。
 * ただし黙って落ちると誤検知の原因を追えないので、呼び出し1回につき1行だけ警告を出す
 * (bdboard-fxxk)。
 */
export async function getCloseEvidenceKeys(
  cache: BoardCache,
  commentReader: CommentReader,
  now: Date,
  windowMs: number,
  options?: GetCloseEvidenceKeysOptions,
): Promise<ReadonlySet<string>> {
  const projectIdFilter = options?.projectIds;
  let entries = cache.listProjects();

  if (projectIdFilter !== undefined) {
    const filterSet = new Set(projectIdFilter);
    entries = entries.filter((entry) => filterSet.has(entry.project.id));
  }

  const items: FetchItem[] = entries.flatMap((entry) =>
    entry.tickets
      .filter(
        (ticket) =>
          ticket.status === 'closed' &&
          ticket.commentCount > 0 &&
          !isExcludedFromCloseEvidenceFetch(ticket) &&
          isValidClosedAt(ticket.closedAt) &&
          isWithinCloseEvidenceWindow(ticket.closedAt, now, windowMs),
      )
      .map((ticket) => ({ entry, ticket })),
  );

  const evidenceKeys = new Set<string>();
  const failures: FetchFailure[] = [];

  await runWithConcurrencyLimit(items, COMMENT_FETCH_CONCURRENCY, async ({ entry, ticket }) => {
    let comments;
    try {
      comments = await commentReader.listComments(entry.project.rootPath, ticket.id);
    } catch (error) {
      failures.push({ id: ticket.id, error });
      return;
    }

    for (const comment of comments) {
      if (commentHasCloseEvidence(comment.text)) {
        evidenceKeys.add(pendingDecisionKey(entry.project.id, ticket.id));
        return;
      }
    }
  });

  if (failures.length > 0) {
    const logWarn = options?.logWarn ?? ((message: string) => console.warn(message));
    logWarn(
      '[close-evidence] could not load comments for some recently closed tickets; ' +
        'they are treated as having no PR/verification evidence, so a ticket that ' +
        `did leave evidence may be reported as closed_without_evidence. ${describeFetchFailures(failures, items.length)}`,
    );
  }

  return evidenceKeys;
}
