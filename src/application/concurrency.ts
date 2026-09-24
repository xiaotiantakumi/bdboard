export async function runWithConcurrencyLimit<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) {
    return;
  }

  const executing = new Set<Promise<void>>();
  for (const item of items) {
    const task = worker(item).finally(() => {
      executing.delete(task);
    });
    executing.add(task);

    if (executing.size >= limit) {
      await Promise.race(executing);
    }
  }

  await Promise.all(executing);
}

/**
 * Semaphore.acquire() の優先度。'low' から 'high' へ戻ることは無い設計 (getPrBadges()
 * の timedOut は一度 true になったら false に戻らない片方向の状態遷移であることが
 * 前提 —— bdboard-gfqz)。
 */
export type SemaphorePriority = 'high' | 'low';

// 'low' 待ちの飢餓防止ガード。'low' 待ちが実際に足止めされている状態で 'high' に
// この回数連続で permit を渡した時点で、次の release は強制的に 'low' に渡す。
const LOW_PRIORITY_STARVATION_GUARD = 4;

interface SemaphoreWaiter {
  readonly resolve: () => void;
  readonly getPriority: () => SemaphorePriority;
}

/**
 * 固定数の「同時実行枠」を acquire/release で貸し出す軽量セマフォ。
 * runWithConcurrencyLimit は単一の静的配列をひとつの concurrency で処理するのに対し、
 * こちらは呼び出し側が個別に acquire/release するため、互いに独立した複数の処理段階
 * (例: 段階A→段階Bの2段パイプライン) がそれぞれ別の同時実行上限を持ちながら並行して
 * 進む場合に使う (bdboard-se3v: get-pr-badges.ts のコメント取得とステータス取得を
 * パイプライン化するために追加。前者が長引いても後者の gh 起動を止めないのが狙い)。
 *
 * bdboard-gfqz: acquire(getPriority) で2段優先度 ('high'/'low') を選べる。同時実行数の
 * 上限 (limit) はこれまでどおり1本のまま —— 優先度は「空いた1枠を待ち手のどちらに
 * 渡すか」の順序だけを変える。
 *
 * 優先度は acquire() を呼んだ時点ではなく、permit を実際に渡す瞬間 (release() の中) に
 * 都度 getPriority() を呼んで再評価する (待ち手ごとに関数のまま保持する設計)。これが
 * 必須な理由: /api/pr-links の実際のトラフィックでは、待ち行列に並ぶ大半の呼び出しは
 * (comment/status キャッシュが温まっているため) 自分のリクエストの overallTimeoutMs が
 * 発火するよりずっと前、マイクロタスク単位でこの Semaphore に並ぶ。つまり「並んだ瞬間」
 * だけで優先度を固定してしまうと、並んだ時点では全員 'high' (まだタイムアウトして
 * いない) のまま並び、その後どれだけタイムアウトが発火しても待ち行列の並び順は変わら
 * ない —— 優先度による並び替えが実質的に一度も効かない (bdboard-gfqz opus レビュー
 * 指摘)。getPriority を関数のまま保持し release() のたびに再評価することで、待って
 * いる間に元のリクエストがタイムアウトして 'low' へ降格した待ち手を、後から来た
 * 本当にまだ応答を待っている 'high' な待ち手より正しく後回しにできる。
 */
export class Semaphore {
  private available: number;
  private readonly waiters: SemaphoreWaiter[] = [];
  private consecutiveHighGrants = 0;

  constructor(limit: number) {
    // limit<=0 や NaN を渡すと acquire() が永久に解決しない静かなハングになる
    // (opus レビューで指摘 — bdboard-se3v)。呼び出し側のバグを早期に落とす。
    if (!Number.isFinite(limit) || limit <= 0) {
      throw new Error(`Semaphore limit must be a positive finite number, got: ${limit}`);
    }
    this.available = limit;
  }

  async acquire(getPriority: () => SemaphorePriority = () => 'high'): Promise<void> {
    if (this.available > 0) {
      this.available -= 1;
      return;
    }
    await new Promise<void>((resolve) => {
      this.waiters.push({ resolve, getPriority });
    });
  }

  release(): void {
    const next = this.dequeueNextWaiter();
    if (next !== undefined) {
      next();
      return;
    }
    this.available += 1;
  }

  /**
   * 次に permit を渡す待ち手を選ぶ。全待ち手の getPriority() を都度呼び直し、到着順を
   * 保ったまま最初の 'high' を選ぶ —— ただし 'low' 待ちが残っている状態で 'high' に
   * LOW_PRIORITY_STARVATION_GUARD 回連続で渡した直後だけ、次の1回は最初の 'low' に
   * 強制的に渡す (bdboard-gfqz)。'high' が1件も無ければ (残り全員 'low') 到着順で
   * 先頭を渡す。
   */
  private dequeueNextWaiter(): (() => void) | undefined {
    if (this.waiters.length === 0) {
      return undefined;
    }

    const highIndex = this.waiters.findIndex((waiter) => waiter.getPriority() === 'high');
    if (highIndex === -1) {
      // 'low' から 'high' へ戻ることは無い設計なので、'high' が1件も無ければ残りは
      // 全部 'low' —— 到着順を保つため先頭を渡す。
      this.consecutiveHighGrants = 0;
      return this.waiters.splice(0, 1)[0]!.resolve;
    }

    const hasLowWaiting = this.waiters.some((waiter) => waiter.getPriority() === 'low');
    if (hasLowWaiting && this.consecutiveHighGrants >= LOW_PRIORITY_STARVATION_GUARD) {
      this.consecutiveHighGrants = 0;
      const lowIndex = this.waiters.findIndex((waiter) => waiter.getPriority() === 'low');
      return this.waiters.splice(lowIndex, 1)[0]!.resolve;
    }

    // 'low' 待ちが実際に足止めされている間だけ数える (足止めしていないときまで数える
    // と、後で 'low' が現れた瞬間にガードが即発動してしまい、ドキュメント通りの
    // 「連続して不利に扱われた」という意味を持たなくなる)。
    this.consecutiveHighGrants = hasLowWaiting ? this.consecutiveHighGrants + 1 : 0;
    return this.waiters.splice(highIndex, 1)[0]!.resolve;
  }
}
