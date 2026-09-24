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
 * Semaphore.acquire() の優先度。省略時は 'high' (優先度を意識しない既存呼び出し元
 * (commentGate 等) との後方互換 —— 'low' を一度も使わなければ単一 FIFO として今までと
 * 同じに振る舞う)。'high' の待ち手は 'low' の待ち手より先に permit を渡されるが、
 * LOW_PRIORITY_STARVATION_GUARD 回連続で 'high' に渡したあとに 'low' 待ちが残って
 * いれば、次の1回は必ず 'low' に渡す —— 'low' が無期限に飢えることはない
 * (bdboard-gfqz)。
 */
export type SemaphorePriority = 'high' | 'low';

// 'low' 待ちの飢餓防止ガード。'high' の待ち手に連続でこの回数 permit を渡した時点で
// 'low' 待ちが1件でも残っていれば、次の release は強制的に 'low' に渡す。
const LOW_PRIORITY_STARVATION_GUARD = 4;

/**
 * 固定数の「同時実行枠」を acquire/release で貸し出す軽量セマフォ。
 * runWithConcurrencyLimit は単一の静的配列をひとつの concurrency で処理するのに対し、
 * こちらは呼び出し側が個別に acquire/release するため、互いに独立した複数の処理段階
 * (例: 段階A→段階Bの2段パイプライン) がそれぞれ別の同時実行上限を持ちながら並行して
 * 進む場合に使う (bdboard-se3v: get-pr-badges.ts のコメント取得とステータス取得を
 * パイプライン化するために追加。前者が長引いても後者の gh 起動を止めないのが狙い)。
 *
 * bdboard-gfqz: acquire(priority) で2段優先度 ('high'/'low') を選べる。同時実行数の
 * 上限 (limit) はこれまでどおり1本のまま —— 優先度は「空いた1枠を待ち手のどちらに
 * 渡すか」の順序だけを変える。全体のスループットや上限そのものは変えない。
 */
export class Semaphore {
  private available: number;
  private readonly highWaiters: Array<() => void> = [];
  private readonly lowWaiters: Array<() => void> = [];
  private consecutiveHighGrants = 0;

  constructor(limit: number) {
    // limit<=0 や NaN を渡すと acquire() が永久に解決しない静かなハングになる
    // (opus レビューで指摘 — bdboard-se3v)。呼び出し側のバグを早期に落とす。
    if (!Number.isFinite(limit) || limit <= 0) {
      throw new Error(`Semaphore limit must be a positive finite number, got: ${limit}`);
    }
    this.available = limit;
  }

  async acquire(priority: SemaphorePriority = 'high'): Promise<void> {
    if (this.available > 0) {
      this.available -= 1;
      return;
    }
    await new Promise<void>((resolve) => {
      (priority === 'low' ? this.lowWaiters : this.highWaiters).push(resolve);
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
   * 次に permit を渡す待ち手を選ぶ。'high' を優先するが、'high' に
   * LOW_PRIORITY_STARVATION_GUARD 回連続で渡した時点で 'low' 待ちが残っていれば、
   * カウンタをリセットしてその1回を必ず 'low' に渡す (bdboard-gfqz)。
   */
  private dequeueNextWaiter(): (() => void) | undefined {
    if (
      this.highWaiters.length > 0 &&
      this.lowWaiters.length > 0 &&
      this.consecutiveHighGrants >= LOW_PRIORITY_STARVATION_GUARD
    ) {
      this.consecutiveHighGrants = 0;
      return this.lowWaiters.shift();
    }
    if (this.highWaiters.length > 0) {
      this.consecutiveHighGrants += 1;
      return this.highWaiters.shift();
    }
    if (this.lowWaiters.length > 0) {
      this.consecutiveHighGrants = 0;
      return this.lowWaiters.shift();
    }
    return undefined;
  }
}
