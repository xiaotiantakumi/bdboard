import type { PrBadge } from '../../domain/pr-link.js';
import type { Semaphore, SemaphorePriority } from '../concurrency.js';
import type { PrStatusReader } from '../ports/pr-status-reader.js';
import type { PrBadgeStatusCache } from './pr-badge-status-cache.js';

/**
 * getPrBadges の「PR ステータス取得」段 (gh pr view 起動) 本体。get-pr-badges.ts から
 * 切り出した (bdboard-se3v: 挙動変更ついでの行数上限対応)。1回の呼び出し全体で共有する
 * 「新規 gh 起動の残り予算」をミュータブルなオブジェクトで受け取り、呼び出しの
 * たびに減算する (プリミティブは参照で渡せないため)。副作用 (失敗/予算切れの
 * 記録) は呼び出し元のコールバック経由で行う。
 */
export interface PrStatusBudget {
  remaining: number;
}

export interface ResolvePrStatusDeps {
  readonly prStatusReader: PrStatusReader;
  readonly statusCache?: PrBadgeStatusCache;
  /**
   * gh pr view の同時起動数を絞る Semaphore (bdboard-ksed)。実際に gh を起動する
   * 呼び出し (statusCache.fetchStatus の in-flight map への登録の起点になった側)
   * だけが acquire/release する —— 既に in-flight の URL に相乗りするだけの呼び出し
   * (alreadyInFlight===true) は fetcher 自体が呼ばれないので、このゲートには一切
   * 触らない。resolve-pr-comment-url.ts の commentGate と同じ設計 (bdboard-ksed:
   * 以前は呼び出し元 get-pr-badges.ts が resolvePrStatus を呼ぶ前に必ず statusGate を
   * acquire していたため、相乗りするだけの呼び出しも共有 gate の枠をフェッチ完了まで
   * 占有してしまい、重なったリクエストの下で本当に新しく gh を起動したい呼び出しの
   * 枠を無駄に減らしていた — bdboard-sgpa の opus レビュー指摘)。
   */
  readonly statusGate: Semaphore;
  readonly budget: PrStatusBudget;
  /** 1リクエストあたりの新規起動上限に達し、今回は見送った (bdboard-7ln6 #6)。 */
  readonly onDeferred: () => void;
  /** gh を実際に起動しに行った (cache/circuit/budget いずれもすり抜けた)。 */
  readonly onAttempt: () => void;
  /** gh 起動が失敗した (バッジ自体は URL だけで出せるので劣化として扱う)。 */
  readonly onFailure: (error: unknown) => void;
  /**
   * statusGate.acquire() へ渡す優先度を acquire する直前に都度評価する。省略時は
   * 常に 'high' (優先度を意識しない既存呼び出し元との後方互換)。getPrBadges() は
   * 自分の overallTimeoutMs 超過後のバックグラウンド継続 (応答は既に返し終えている)
   * では 'low' を返し、まだ応答を待っている別リクエストの 'high' な gh 起動を
   * 先に通す (bdboard-gfqz)。
   */
  readonly getPriority?: () => SemaphorePriority;
}

export async function resolvePrStatus(
  url: string,
  deps: ResolvePrStatusDeps,
): Promise<PrBadge['status']> {
  const {
    prStatusReader,
    statusCache,
    statusGate,
    budget,
    getPriority,
    onDeferred,
    onAttempt,
    onFailure,
  } = deps;
  const cachedStatus = statusCache?.get(url);

  if (cachedStatus !== undefined) {
    return cachedStatus;
  }

  if (statusCache === undefined) {
    // statusCache 未指定: in-flight 共有ができない (キャッシュに紐づく状態なので)
    // ので、従来通り毎回ゲート越しに直接フェッチする。
    await statusGate.acquire(getPriority?.() ?? 'high');
    try {
      onAttempt();
      const result = await prStatusReader.getPrStatus(url);
      return result.status;
    } catch (error) {
      onFailure(error);
      return null;
    } finally {
      statusGate.release();
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
    const { promise } = statusCache.fetchStatus(url, async () => {
      // ここが実際に gh を起動する側だけが通る経路 (alreadyInFlight===false で
      // in-flight map への登録の起点になった呼び出し)。相乗りする呼び出しは
      // fetchStatus() が既存の Promise をそのまま返すため、この fetcher 自体が
      // 呼ばれない — statusGate を待つのはここだけ (bdboard-ksed)。
      await statusGate.acquire(getPriority?.() ?? 'high');
      try {
        // ゲート待ちの間にサーキットが開いた可能性がある。関数冒頭の
        // isCircuitOpen() チェックはゲート取得より前なので、ゲート待ちで詰まって
        // いる間のトリップまでは拾えない —— 実際に起動する直前でもう一度確認する
        // (bdboard-ksed 課題文の「evaluate the circuit right before launch」)。
        // rate-limit 扱いで返すと PrBadgeStatusCache.recordResult が tripCircuit()
        // を呼ぶが、既に open なら no-op (二重ログ・二重バックオフにはならない)。
        if (statusCache.isCircuitOpen()) {
          return { status: null, reason: 'rate-limit' } as const;
        }
        return await prStatusReader.getPrStatus(url);
      } finally {
        statusGate.release();
      }
    });
    const result = await promise;
    return result.status;
  } catch (error) {
    // バッジ自体は URL だけで出せるので、状態が引けないのは劣化であって失敗ではない。
    onFailure(error);
    return null;
  }
}
