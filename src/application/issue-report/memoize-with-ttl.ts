/**
 * 非同期の読み込み結果を ttlMs だけ使い回す。成功した値だけを覚え、失敗は覚えない。値の期限は、読み込みが終わった時刻から数える。
 * 進行中の読み込み (pending) の共有にも同じ ttlMs の期限を掛ける (bdboard-ov0t): 終わらない読み込みを期限なく共有すると、
 * 以後のすべての呼び出しが同じ決着しない promise を待ち続ける。期限を過ぎた進行中の読み込みは共有せず、新しく読み始める。
 * 古い読み込みがあとで終わっても、自分の呼び出し側には自分の値が返る。覚えるのは、それより新しく始めた読み込みの値がまだ無いときだけで、
 * 新しい読み込みの値は上書きしない (bdboard-pvff)。覚えないと、読み込みが毎回 ttlMs より長いとき、どの読み込みも置き換えられてから
 * 終わるので、値が一度も覚えられない。「新しい」は時計ではなく読み込みを始めた順 (sequence) で決める。時計は戻ることがある。
 */
export function memoizeAsyncWithTtl<T>(load: () => Promise<T>, ttlMs: number, now: () => number): () => Promise<T> {
  let cached: { readonly value: T; readonly loadedAt: number; readonly sequence: number } | undefined;
  let pending: { readonly promise: Promise<T>; readonly startedAt: number; readonly sequence: number } | undefined;
  let lastSequence = 0;
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

    lastSequence += 1;
    const request = load();
    const entry = { promise: request, startedAt: current, sequence: lastSequence };
    pending = entry;
    void request.then(
      (value) => {
        // 置き換えられた古い読み込みの値は、それより新しく始めた読み込みの値がもう覚えられているときは、覚えない (上書きしない)。
        if (cached === undefined || cached.sequence < entry.sequence) cached = { value, loadedAt: now(), sequence: entry.sequence };
        // 進行中の印を外すのは、自分がまだ進行中の読み込みのときだけ (置き換えた新しい読み込みは手放さない)。
        if (pending === entry) pending = undefined;
      },
      () => {
        if (pending === entry) pending = undefined;
      },
    );
    return request;
  };
}
