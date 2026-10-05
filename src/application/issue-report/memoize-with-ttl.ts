export function memoizeAsyncWithTtl<T>(load: () => Promise<T>, ttlMs: number, now: () => number): () => Promise<T> {
  let cached: { readonly value: T; readonly loadedAt: number } | undefined;
  let pending: { readonly promise: Promise<T>; readonly startedAt: number } | undefined;
  return () => {
    const current = now();
    if (cached !== undefined) {
      const elapsed = current - cached.loadedAt;
      if (elapsed >= 0 && elapsed < ttlMs) return Promise.resolve(cached.value);
    }
    if (pending !== undefined && current - pending.startedAt >= 0) return pending.promise;

    const startedAt = current;
    const request = load();
    const entry = { promise: request, startedAt };
    pending = entry;
    void request.then(
      (value) => {
        cached = { value, loadedAt: now() };
        if (pending === entry) pending = undefined;
      },
      () => {
        if (pending === entry) pending = undefined;
      },
    );
    return request;
  };
}
