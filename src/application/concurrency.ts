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
 * 固定数の「同時実行枠」を acquire/release で貸し出す軽量セマフォ。
 * runWithConcurrencyLimit は単一の静的配列をひとつの concurrency で処理するのに対し、
 * こちらは呼び出し側が個別に acquire/release するため、互いに独立した複数の処理段階
 * (例: 段階A→段階Bの2段パイプライン) がそれぞれ別の同時実行上限を持ちながら並行して
 * 進む場合に使う (bdboard-se3v: get-pr-badges.ts のコメント取得とステータス取得を
 * パイプライン化するために追加。前者が長引いても後者の gh 起動を止めないのが狙い)。
 */
export class Semaphore {
  private available: number;
  private readonly waiters: Array<() => void> = [];

  constructor(limit: number) {
    // limit<=0 や NaN を渡すと acquire() が永久に解決しない静かなハングになる
    // (opus レビューで指摘 — bdboard-se3v)。呼び出し側のバグを早期に落とす。
    if (!Number.isFinite(limit) || limit <= 0) {
      throw new Error(`Semaphore limit must be a positive finite number, got: ${limit}`);
    }
    this.available = limit;
  }

  async acquire(): Promise<void> {
    if (this.available > 0) {
      this.available -= 1;
      return;
    }
    await new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  release(): void {
    const next = this.waiters.shift();
    if (next !== undefined) {
      next();
      return;
    }
    this.available += 1;
  }
}
