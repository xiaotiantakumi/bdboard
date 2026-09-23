// bdboard-ve1y: getThroughputStats / getModelStats はチケット数が多いと
// 同期ループのままイベントループを長時間塞ぎ、その裏で /api/health や
// /api/tickets/<id> を待たせていた (bdboard-himp 実測: 10〜25秒)。
// AGGREGATION_YIELD_CHUNK_SIZE 件処理するごとに setImmediate で1マクロタスク
// 分を明け渡し、保留中の他リクエストが処理される隙を作る。
//
// microtask (Promise.resolve() 等) ではなく setImmediate を使うのが要点:
// Node は現在のコールスタックが空になった後、次のフェーズへ進む前に
// マイクロタスクキューを完全に空にする。ループ内で
// `await Promise.resolve()` を繰り返しても、その継続はマイクロタスクとして
// 積まれ続けるだけで poll フェーズ (他リクエストの受付) には戻らない。
// setImmediate はマクロタスク (check フェーズ) なので、他の保留中の
// I/O コールバックが間に処理される。
export const AGGREGATION_YIELD_CHUNK_SIZE = 500;

export async function yieldToEventLoop(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

export interface YieldGate {
  /**
   * 1件処理するたびに呼ぶ。呼び出し回数が chunkSize に達するごとに
   * yieldToEventLoop() する。カウンタは gate 自身が保持するので、複数の
   * 配列/ループ (例: プロジェクトをまたぐチケット集計) にまたがって
   * 同じ gate を使い回しても、チャンク境界は通算件数で決まる
   * (プロジェクトごとにリセットされない)。
   */
  tick(): Promise<void>;
}

export function createYieldGate(chunkSize: number = AGGREGATION_YIELD_CHUNK_SIZE): YieldGate {
  let processed = 0;
  return {
    async tick(): Promise<void> {
      processed += 1;
      if (processed % chunkSize === 0) {
        await yieldToEventLoop();
      }
    },
  };
}

/**
 * items を順番に visit しつつ、gate 経由でチャンク境界ごとにイベントループへ
 * 制御を返す。visit の呼び出し順序・回数は同期版の for-of ループと同一なので、
 * 集計結果は変わらない。gate を省略すると items 単体用の gate を新規作成する
 * (単一配列で完結する場合はそれで十分)。プロジェクトをまたいで通算したい
 * 場合は呼び出し側で作った gate を渡す。
 */
export async function forEachChunked<T>(
  items: readonly T[],
  visit: (item: T, index: number) => void,
  gate: YieldGate = createYieldGate(),
): Promise<void> {
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (item !== undefined) {
      visit(item, index);
    }
    await gate.tick();
  }
}
