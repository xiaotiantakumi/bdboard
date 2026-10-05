/**
 * 窓の中で使える回数の上限 (滑る窓)。届いた issue の gh の呼び出しを、1 時間に何回までと数えるのに使う
 * (bdboard-4y8q.9.4、docs/ISSUE-REPORTING.md 8節)。
 */
export interface SlidingWindowBudget {
  /** 使えるなら 1 回分を使って true。窓の中にすでに上限の数があれば、使わずに false。 */
  tryConsume(): boolean;
  /** 窓の中で使った回数。 */
  used(): number;
}

export interface SlidingWindowBudgetOptions {
  /** 窓の中で使える回数 (正の整数)。 */
  readonly limit: number;
  /** 窓の長さ (ミリ秒、正の有限数)。 */
  readonly windowMs: number;
  /** 時計 (ミリ秒)。本番は単調な時計 (`performance.now()`) を渡す: 壁時計が進んでも窓が早く空かないように。 */
  readonly now: () => number;
}

/**
 * 使った時刻を覚え、`windowMs` 以上前のものを窓の外として捨てる (ちょうど `windowMs` 前は外)。
 * 受け付けた時刻の列は、どの連続する `limit + 1` 個も最初と最後が `windowMs` 以上離れる: だから、どの長さ `windowMs` の窓にも
 * `limit` 回を超えて入らない。時計が戻っても、使った回数は減らさない (古い記録を捨てるのは `now - 使った時刻 >= windowMs` のときだけ)。
 */
export function createSlidingWindowBudget(options: SlidingWindowBudgetOptions): SlidingWindowBudget {
  if (!Number.isInteger(options.limit) || options.limit <= 0) {
    throw new RangeError('limit must be a positive integer');
  }
  if (!Number.isFinite(options.windowMs) || options.windowMs <= 0) {
    throw new RangeError('windowMs must be a positive finite number');
  }
  const usedAt: number[] = [];

  function dropExpired(nowMs: number): void {
    for (let oldest = usedAt[0]; oldest !== undefined && nowMs - oldest >= options.windowMs; oldest = usedAt[0]) {
      usedAt.shift();
    }
  }

  return {
    tryConsume() {
      const nowMs = options.now();
      dropExpired(nowMs);
      if (usedAt.length >= options.limit) return false;
      usedAt.push(nowMs);
      return true;
    },
    used() {
      dropExpired(options.now());
      return usedAt.length;
    },
  };
}
