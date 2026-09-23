import { extractLatestPrUrl } from '../../domain/pr-link.js';
import { hasCloseEvidenceMarker } from './close-evidence-marker.js';
import type { Semaphore } from '../concurrency.js';
import type { CachedProject } from '../ports/board-cache.js';
import type { CommentReader } from '../ports/comment-reader.js';
import type { Ticket } from '../../domain/ticket.js';
import type { PrBadgeCommentCache } from './pr-badge-comment-cache.js';

/**
 * get-pr-badges.ts の runTicket から切り出した (bdboard-sgpa: 行数上限対応。move only、
 * 挙動は1文字も変えていない)。1チケットぶんの PR URL 解決: キャッシュヒット → in-flight
 * 共有 + ゲート待ち後のキャッシュ再確認 → 直接フェッチ (commentCache 未指定時) の3経路。
 * 失敗時は reject する (呼び出し側で commentFailures に積んでプレースホルダを消す)。
 */
export interface ResolvePrCommentUrlDeps {
  readonly commentReader: CommentReader;
  readonly commentCache?: PrBadgeCommentCache;
  readonly commentGate: Semaphore;
}

export async function resolvePrCommentUrl(
  entry: CachedProject,
  ticket: Ticket,
  { commentReader, commentCache, commentGate }: ResolvePrCommentUrlDeps,
): Promise<string | null> {
  const updatedAtMs = ticket.updatedAt.getTime();
  const cachedUrl = commentCache?.get(ticket.id, ticket.commentCount, updatedAtMs);
  if (cachedUrl !== undefined) {
    // キャッシュヒットは実際の bd 呼び出しが無いので commentGate を消費しない。
    return cachedUrl;
  }

  if (commentCache !== undefined) {
    // bdboard-sgpa: commentCache.resolveUrl が in-flight 共有と、ゲート待ちの後の
    // キャッシュ再確認 (fetcher 内部) を面倒見る。同じチケットの解決が既に他の重なった
    // リクエストで進行中なら、ここで新しく bd を起動せずその結果を待つ。
    return commentCache.resolveUrl(ticket.id, ticket.commentCount, updatedAtMs, async () => {
      await commentGate.acquire();
      try {
        // ゲート待ちの間に、別の重なったリクエストが同じ (ticketId, commentCount,
        // updatedAt) を先に解決し終えているかもしれない (in-flight の相乗りに間に
        // 合わなかった競合)。無駄な bd 起動を避けるため、ゲートを取ってからもう
        // 一度キャッシュを見る (bdboard-sgpa)。
        const cachedAfterGate = commentCache.get(ticket.id, ticket.commentCount, updatedAtMs);
        if (cachedAfterGate !== undefined) {
          return {
            url: cachedAfterGate,
            hasCloseEvidence:
              commentCache.getCloseEvidence(ticket.id, ticket.commentCount, updatedAtMs) ?? false,
          };
        }
        const comments = await commentReader.listComments(entry.project.rootPath, ticket.id);
        const resolvedUrl = extractLatestPrUrl(comments);
        const hasCloseEvidence = comments.some((c) => hasCloseEvidenceMarker(c.text));
        return { url: resolvedUrl, hasCloseEvidence };
      } finally {
        commentGate.release();
      }
    });
  }

  // commentCache 未指定: キャッシュも in-flight 共有も効かせようがないので、従来通り
  // 毎回ゲート越しに直接フェッチする。
  await commentGate.acquire();
  try {
    const comments = await commentReader.listComments(entry.project.rootPath, ticket.id);
    return extractLatestPrUrl(comments);
  } finally {
    commentGate.release();
  }
}
