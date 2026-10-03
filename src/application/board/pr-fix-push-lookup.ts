import type { BoardCache } from '../ports/board-cache.js';
import type { CommentReader } from '../ports/comment-reader.js';
import type { PrStatusReader } from '../ports/pr-status-reader.js';
import {
  isFixPushStatsTarget,
  type FixPushLookup,
  type FixPushLookupResult,
} from './fix-push-lookup-types.js';
import { getPrBadges } from './get-pr-badges.js';
import type { PrBadgeShared } from './pr-badge-shared.js';

/**
 * 統計の「修正 push 回数」を、既存の PR 情報キャッシュ (PrBadgeCommentCache の PR URL +
 * PrBadgeStatusCache の gh pr view 結果) から引き当てる (bdboard-p5l.27)。
 *
 * このモジュールの lookup は **同期でキャッシュを読むだけ**: gh も bd も起動しない。統計 API
 * (/api/model-stats) は重い集計なので、リクエストの中で外部コマンドを待たせてレイテンシを
 * 悪化させないための設計。取れていない分は pending として返し、warm (下) が裏で埋める。
 */

const NO_PR: FixPushLookupResult = { kind: 'unknown', pending: false };
const PENDING: FixPushLookupResult = { kind: 'unknown', pending: true };

export function createFixPushLookup(
  shared: Pick<PrBadgeShared, 'commentCache' | 'statusCache'>,
): FixPushLookup {
  const { commentCache, statusCache } = shared;
  return (ticket) => {
    if (ticket.commentCount <= 0) {
      // コメントが無いので PR: <url> も無い — 確定した「不明」。
      return NO_PR;
    }
    const url = commentCache.get(ticket.id, ticket.commentCount, ticket.updatedAt.getTime());
    if (url === undefined) {
      return PENDING;
    }
    if (url === null) {
      // コメントを読んだが PR: <url> が無かった — 確定した「不明」。
      return NO_PR;
    }
    const status = statusCache.peekStatus(url);
    if (status === undefined) {
      return PENDING;
    }
    if (status === null) {
      // 直近の gh 取得が失敗 (否定キャッシュ)。再試行間隔はキャッシュ側が管理するので、
      // ここでは pending 扱いにせず、統計側のポーリングを増やさない。
      return NO_PR;
    }
    if (typeof status.fixPushCount === 'number') {
      return { kind: 'known', count: status.fixPushCount };
    }
    // null = gh は応答したが日時が読めなかった (確定した不明)。undefined = この項目が入る前
    // の古い恒久エントリで、先読みが取り直すまで pending。
    return status.fixPushCount === null ? NO_PR : PENDING;
  };
}

export interface FixPushWarmerDeps {
  readonly cache: BoardCache;
  readonly commentReader: CommentReader;
  readonly prStatusReader: PrStatusReader;
  readonly shared: PrBadgeShared;
  readonly logWarn?: (message: string) => void;
}

/**
 * 1回の先読みで新規に起動する gh の上限。画面のバッジ取得 (/api/pr-links) と gh の
 * 同時実行ゲートを共有するので、無制限にはしない。残りは次の統計取得 (ポーリング)
 * の先読みに回る。
 */
const WARM_MAX_NEW_FETCHES = 50;

/**
 * 統計の対象チケット (クローズ済みで複雑度/実装モデルが記録されたもの) の PR URL と
 * gh pr view の結果を、バックグラウンドで共有キャッシュへ温める。
 *
 * getPrBadges をそのまま使うので、サーキットブレーカー・否定キャッシュ・in-flight 共有・
 * 同時実行ゲート・失敗ログは既存どおり。違いは (1) 対象チケットを絞る (ticketFilter)、
 * (2) fixPushCount が省略された古い恒久エントリも取り直す (requireFixPushCount)、
 * (3) gh の待ち行列で常に low 優先度 (画面のバッジ取得を後回しにしない)。
 *
 * 同じプロジェクト絞り込みの先読みが走っている間は重ねて起動しない (single-flight)。
 * 返す Promise は先読みの完了で解決し、失敗しても reject しない (呼び出し側は待たずに
 * 捨ててよい。テストだけが await する)。
 */
export function createFixPushWarmer(
  deps: FixPushWarmerDeps,
): (projectIds?: readonly string[]) => Promise<void> {
  const inFlight = new Map<string, Promise<void>>();
  const logWarn = deps.logWarn ?? ((message: string) => console.warn(message));

  return (projectIds) => {
    const key = projectIds === undefined ? '*' : [...projectIds].sort().join(',');
    const running = inFlight.get(key);
    if (running !== undefined) {
      return running;
    }

    const promise = getPrBadges(deps.cache, deps.commentReader, deps.prStatusReader, {
      ...(projectIds !== undefined ? { projectIds } : {}),
      commentCache: deps.shared.commentCache,
      statusCache: deps.shared.statusCache,
      gates: deps.shared.gates,
      ticketFilter: isFixPushStatsTarget,
      requireFixPushCount: true,
      lowPriority: true,
      maxNewFetchesPerCall: WARM_MAX_NEW_FETCHES,
      logWarn,
    })
      .then(() => undefined)
      .catch((error: unknown) => {
        logWarn(
          `[model-stats] could not warm PR fix-push counts: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      })
      .finally(() => {
        inFlight.delete(key);
      });
    inFlight.set(key, promise);
    return promise;
  };
}
