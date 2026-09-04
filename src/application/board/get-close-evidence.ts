import { needsCloseEvidenceLookup, pendingDecisionKey } from '../../domain/hygiene.js';
import type { BoardCache } from '../ports/board-cache.js';
import type { PrBadgeCommentCache } from './get-pr-badges.js';

export interface CloseEvidence {
  /** コメントに PR:/検証: があると確認できたチケット。 */
  readonly evidenceKeys: ReadonlySet<string>;
  /** 今回のリクエストでは確認しきれなかったチケット（未確認）。 */
  readonly unknownKeys: ReadonlySet<string>;
}

export interface GetCloseEvidenceOptions {
  /** 指定されたIDのみ。未指定なら全部 */
  readonly projectIds?: readonly string[];
  /** 取得失敗の警告ログ。未指定なら console.warn (discover-projects と同じ注入流儀)。 */
  readonly logWarn?: (message: string) => void;
  /** PR バッジ用の走査結果を再利用する共有キャッシュ。未指定なら全件 unknown。 */
  readonly sharedCommentCache?: PrBadgeCommentCache;
}

/**
 * close 済みチケットのコメントから PR/検証の記録があるかを返す (bdboard-pkr6.8)。
 *
 * bd comments は issue-id 必須で1チケットずつプロセスを起動するため、ここでは
 * **一切 bd comments を起動しない**。PR バッジ用の走査 (getPrBadges) が
 * commentCount > 0 の全チケットについて既に行っている結果を PrBadgeCommentCache
 * 経由で読むだけ (bdboard-pkr6.16)。否定 TTL は持たない — 詳細は
 * PrBadgeCommentCache.getCloseEvidence() の JSDoc を参照。
 *
 * 対象はドメインの needsCloseEvidenceLookup() で絞る (closeReason に証拠がある
 * 件は bd を叩かない)。共有キャッシュにまだ載っていないチケットは unknownKeys
 * として返す — 未確認は closed_without_evidence として出さない。
 *
 * 共有キャッシュの pruning は getPrBadges 側が担当する (二重 prune を避ける)。
 *
 * 呼び出し側の `await getCloseEvidence(...)` を変えずに済むよう、内部で await が
 * 無くても async のままにしている。
 */
export async function getCloseEvidence(
  cache: BoardCache,
  now: Date,
  windowMs: number,
  options?: GetCloseEvidenceOptions,
): Promise<CloseEvidence> {
  const projectIdFilter = options?.projectIds;
  const allEntries = cache.listProjects();
  let entries = allEntries;

  if (projectIdFilter !== undefined) {
    const filterSet = new Set(projectIdFilter);
    entries = entries.filter((entry) => filterSet.has(entry.project.id));
  }

  const sharedCommentCache = options?.sharedCommentCache;

  const evidenceKeys = new Set<string>();
  const unknownKeys = new Set<string>();
  let totalCandidates = 0;

  for (const entry of entries) {
    for (const ticket of entry.tickets) {
      if (!needsCloseEvidenceLookup(ticket, now, windowMs)) {
        continue;
      }

      totalCandidates += 1;
      const key = pendingDecisionKey(entry.project.id, ticket.id);
      const cached = sharedCommentCache?.getCloseEvidence(
        ticket.id,
        ticket.commentCount,
        ticket.updatedAt.getTime(),
      );

      if (cached === true) {
        evidenceKeys.add(key);
      } else if (cached === false) {
        // 証拠なし確定。
      } else {
        unknownKeys.add(key);
      }
    }
  }

  if (unknownKeys.size > 0) {
    const logWarn = options?.logWarn ?? ((message: string) => console.warn(message));
    logWarn(
      `[close-evidence] ${unknownKeys.size} of ${totalCandidates} recently closed tickets ` +
        'are not yet covered by the PR-badge comment scan; ' +
        'closed_without_evidence may be under-reported until those tickets are scanned.',
    );
  }

  return { evidenceKeys, unknownKeys };
}
