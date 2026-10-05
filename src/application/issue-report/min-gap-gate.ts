export type MinGapResult = { readonly ok: true } | { readonly ok: false; readonly retryAfterMs: number };
export interface MinGapGate { tryPass(): MinGapResult }

export function createMinGapGate(options: { readonly minGapMs: number; readonly now: () => number }): MinGapGate {
  let last: number | undefined;
  return {
    tryPass() {
      const now = options.now();
      if (last !== undefined && now - last < options.minGapMs) {
        return { ok: false, retryAfterMs: options.minGapMs - (now - last) };
      }
      last = now;
      return { ok: true };
    },
  };
}
