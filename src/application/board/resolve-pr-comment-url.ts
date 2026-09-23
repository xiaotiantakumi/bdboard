import { extractLatestPrUrl } from '../../domain/pr-link.js';
import { hasCloseEvidenceMarker } from './close-evidence-marker.js';
import type { Semaphore } from '../concurrency.js';
import type { CachedProject } from '../ports/board-cache.js';
import type { CommentReader } from '../ports/comment-reader.js';
import type { Ticket } from '../../domain/ticket.js';
import type { PrBadgeCommentCache } from './pr-badge-comment-cache.js';

/**
 * get-pr-badges.ts の runTicket から切り出した (bdboard-sgpa: 行数上限対応)。
 * このファイルの中身自体 (キャッシュヒット判定・in-flight 共有・ゲート待ち後の
 * キャッシュ再確認・直接フェッチ) は bdboard-sgpa でこの PR 内に新規追加したロジック
 * であり、main の既存コードからの move ではない —— このファイルへの「切り出し」は
 * 同じ PR 内で runTicket に一度実装した後にここへ移した、という意味 (opus レビュー
 * 指摘: 以前の「move only、挙動は1文字も変えていない」は main からの移動であるかの
 * ように読めて誤解を招くため訂正)。1チケットぶんの PR URL 解決: キャッシュヒット →
 * in-flight 共有 + ゲート待ち後のキャッシュ再確認 → 直接フェッチ (commentCache 未指定時)
 * の3経路。失敗時は reject する (呼び出し側で commentFailures に積んでプレースホルダを
 * 消す)。
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
        // 防御的な再確認: resolveUrl() は cache→in-flight の判定と fetcher() 呼び出しの
        // 登録を同期的に (await を挟まず) 行うため、現状の実装では in-flight 登録より
        // 前に他の呼び出しがこのキーへ書き込む経路は無く、この再確認が実際に「無駄な
        // bd 起動を防いだ」ことは無いはず (opus レビュー指摘)。とはいえコストはほぼ
        // ゼロで、将来 set() の呼び出し元が増えたときの安全網として残す価値はあるため
        // 削除はしていない —— 「競合を防いでいる」という説明が実態と合っていなかった
        // 点だけを訂正する。
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
