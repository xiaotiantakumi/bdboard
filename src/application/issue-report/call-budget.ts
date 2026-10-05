export interface SlidingWindowBudget {
  tryConsume(): boolean;
  used(): number;
}

export function createSlidingWindowBudget(options: {
  readonly limit: number;
  readonly windowMs: number;
  readonly now: () => number;
}): SlidingWindowBudget {
  if (!Number.isInteger(options.limit) || options.limit <= 0) throw new RangeError('limit must be a positive integer');
  if (!Number.isFinite(options.windowMs) || options.windowMs <= 0) throw new RangeError('windowMs must be positive and finite');
  const timestamps: number[] = [];
  function prune(now: number): void {
    while (timestamps.length > 0 && now - timestamps[0]! >= options.windowMs) timestamps.shift();
  }
  return {
    tryConsume() {
      const now = options.now();
      prune(now);
      if (timestamps.length >= options.limit) return false;
      timestamps.push(now);
      return true;
    },
    used() {
      prune(options.now());
      return timestamps.length;
    },
  };
}
