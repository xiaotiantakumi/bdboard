/**
 * 非同期の読み込み結果を ttlMs だけ使い回す。成功した値だけを覚え、失敗は覚えない。
 * 進行中の読み込み (pending) の共有にも同じ ttlMs の期限を掛ける (bdboard-ov0t): 終わらない読み込みを期限なく共有すると、
 * 以後のすべての呼び出しが同じ決着しない promise を待ち続ける。期限を過ぎた進行中の読み込みは共有せず、新しく読み始める。
 * 古い読み込みがあとで終わっても、値は自分の呼び出し側にだけ返し、新しい読み込みの値は上書きしない。
 */
export function memoizeAsyncWithTtl<T>(load: () => Promise<T>, ttlMs: number, now: () => number): () => Promise<T> {
  let cached: { readonly value: T; readonly loadedAt: number } | undefined;
  let pending: { readonly promise: Promise<T>; readonly startedAt: number } | undefined;
  return () => {
    const current = now();
    if (cached !== undefined) {
      const elapsed = current - cached.loadedAt;
      if (elapsed >= 0 && elapsed < ttlMs) return Promise.resolve(cached.value);
    }
    if (pending !== undefined) {
      // 時計が戻った (経過が負) ときと、期限を過ぎたときは共有しない。
      const waited = current - pending.startedAt;
      if (waited >= 0 && waited < ttlMs) return pending.promise;
    }

    const request = load();
    const entry = { promise: request, startedAt: current };
    pending = entry;
    void request.then(
      (value) => {
        // 新しい読み込みに置き換わったあとの古い読み込みは、値を覚えない。
        if (pending !== entry) return;
        cached = { value, loadedAt: now() };
        pending = undefined;
      },
      () => {
        if (pending === entry) pending = undefined;
      },
    );
    return request;
  };
}
