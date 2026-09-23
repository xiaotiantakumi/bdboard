import type { PrBadge } from '../../domain/pr-link.js';
import type { PrStatusReader } from '../ports/pr-status-reader.js';
import type { PrBadgeStatusCache } from './pr-badge-status-cache.js';

/**
 * getPrBadges の「PR ステータス取得」段 (gh pr view 起動) 本体。get-pr-badges.ts から
 * 切り出した (bdboard-se3v: 挙動変更ついでの行数上限対応)。1回の呼び出し全体で共有する
 * 「新規 gh 起動の残り予算」をミュータブルなオブジェクトで受け取り、呼び出しの
 * たびに減算する (プリミティブは参照で渡せないため)。副作用 (失敗/予算切れの
 * 記録) は呼び出し元のコールバック経由で行う —— ロジック自体は分割前と1文字も
 * 変えていない。
 */
export interface PrStatusBudget {
  remaining: number;
}

export interface ResolvePrStatusDeps {
  readonly prStatusReader: PrStatusReader;
  readonly statusCache?: PrBadgeStatusCache;
  readonly budget: PrStatusBudget;
  /** 1リクエストあたりの新規起動上限に達し、今回は見送った (bdboard-7ln6 #6)。 */
  readonly onDeferred: () => void;
  /** gh を実際に起動しに行った (cache/circuit/budget いずれもすり抜けた)。 */
  readonly onAttempt: () => void;
  /** gh 起動が失敗した (バッジ自体は URL だけで出せるので劣化として扱う)。 */
  readonly onFailure: (error: unknown) => void;
}

export async function resolvePrStatus(
  url: string,
  deps: ResolvePrStatusDeps,
): Promise<PrBadge['status']> {
  const { prStatusReader, statusCache, budget, onDeferred, onAttempt, onFailure } = deps;
  const cachedStatus = statusCache?.get(url);

  if (cachedStatus !== undefined) {
    return cachedStatus;
  }

  if (statusCache === undefined) {
    // statusCache 未指定: 従来通り毎回フェッチする (サーキット/予算/in-flight
    // 共有はキャッシュに紐づく状態なので、キャッシュが無ければ効かせようがない)。
    onAttempt();
    try {
      const result = await prStatusReader.getPrStatus(url);
      return result.status;
    } catch (error) {
      onFailure(error);
      return null;
    }
  }

  if (statusCache.isCircuitOpen()) {
    // rate-limit のクールダウン中: gh を1回も起動しない (bdboard-7ln6 #2)。
    return null;
  }

  const alreadyInFlight = statusCache.isInFlight(url);
  if (!alreadyInFlight && budget.remaining <= 0) {
    // 1リクエストあたりの新規起動上限に達した。今回は URL のみのバッジで妥協し、
    // 残りは次回の呼び出し (board.changed のたびに来る) に回す (bdboard-7ln6 #6)。
    onDeferred();
    return null;
  }

  if (!alreadyInFlight) {
    budget.remaining -= 1;
  }
  onAttempt();
  try {
    const { promise } = statusCache.fetchStatus(url, () => prStatusReader.getPrStatus(url));
    const result = await promise;
    return result.status;
  } catch (error) {
    // バッジ自体は URL だけで出せるので、状態が引けないのは劣化であって失敗ではない。
    onFailure(error);
    return null;
  }
}
