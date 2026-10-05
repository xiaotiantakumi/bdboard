export type MinGapResult =
  | { readonly ok: true }
  /** 通せない。`retryAfterMs` は、次に通るまでの残り (ミリ秒)。 */
  | { readonly ok: false; readonly retryAfterMs: number };

/**
 * 「前に通してから一定の間隔があくまで通さない」関所 (bdboard-4y8q.9.4。手動の refresh を 60 秒に 1 回にする)。
 */
export interface MinGapGate {
  /** 通せるなら通して、通した時刻を覚える。通せないときは時刻を進めない (弾かれ続けても、通れる時刻は延びない)。 */
  tryPass(): MinGapResult;
}

export interface MinGapGateOptions {
  readonly minGapMs: number;
  /** 時計 (ミリ秒)。 */
  readonly now: () => number;
}

export function createMinGapGate(options: MinGapGateOptions): MinGapGate {
  let lastPassedAt: number | undefined;
  return {
    tryPass() {
      const nowMs = options.now();
      if (lastPassedAt !== undefined) {
        const elapsedMs = nowMs - lastPassedAt;
        if (elapsedMs < options.minGapMs) {
          return { ok: false, retryAfterMs: options.minGapMs - elapsedMs };
        }
      }
      lastPassedAt = nowMs;
      return { ok: true };
    },
  };
}
