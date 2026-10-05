/**
 * bdboard 本体のエラーを下書きにするときの間引き (bdboard-4y8q.6.2)。
 *
 * 画面の自動更新のたびに同じエラーが出るので、キーごとに「最後に報告した時刻」を持ち、同じキーは既定で 1 時間に 1 回だけ報告させる。
 * IO は持たない。時刻は呼び出し側から受け取り、状態は `createSelfErrorThrottle` が返すオブジェクトの中だけに置く。
 */
export const DEFAULT_SELF_ERROR_THROTTLE_INTERVAL_MS = 60 * 60 * 1000;
/** 覚えるキーの数の上限。キーは伏せたエラー文を含むので、増え続けないようにする。 */
export const DEFAULT_SELF_ERROR_THROTTLE_MAX_KEYS = 500;

export interface SelfErrorThrottleOptions {
  /** 既定 1 時間。0 は「毎回報告」。負・NaN・Infinity は既定に戻す。 */
  readonly intervalMs?: number;
  /** 既定 500。小数は切り捨て、1 未満・NaN は既定に戻す。 */
  readonly maxKeys?: number;
}

export interface SelfErrorThrottle {
  /**
   * 初めて見るキー、または最後の報告から intervalMs 以上たっているキーなら true を返し、最後の報告時刻を now にする。
   * それ以外は false で、最後の報告時刻は動かさない (続いている間は intervalMs ごとに 1 回だけ true になる)。
   * どちらの場合も、そのキーを「最近使った」側に入れる (LRU)。
   */
  shouldReport(key: string, now: Date): boolean;
  /** キーを忘れる。エラーが解消したあと、次に現れたら「初めて」として扱うために使う。無いキーは何もしない。 */
  forget(key: string): void;
  /** 覚えているキーの数 (テスト・診断用)。 */
  size(): number;
}

function intervalOf(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested) || requested < 0) {
    return DEFAULT_SELF_ERROR_THROTTLE_INTERVAL_MS;
  }
  return requested;
}

function maxKeysOf(requested: number | undefined): number {
  const floored = Math.floor(requested ?? DEFAULT_SELF_ERROR_THROTTLE_MAX_KEYS);
  return Number.isFinite(floored) && floored >= 1 ? floored : DEFAULT_SELF_ERROR_THROTTLE_MAX_KEYS;
}

export function createSelfErrorThrottle(options: SelfErrorThrottleOptions = {}): SelfErrorThrottle {
  const intervalMs = intervalOf(options.intervalMs);
  const maxKeys = maxKeysOf(options.maxKeys);
  // Map の挿入順をそのまま LRU の順に使う (使うたびに末尾へ移す)。値は最後の報告時刻 (ミリ秒)。
  const lastReported = new Map<string, number>();

  return {
    shouldReport(key, now) {
      const current = now.getTime();
      // 時刻が分からないものを、報告済みにも未報告にもしない。
      if (Number.isNaN(current)) return false;
      const previous = lastReported.get(key);
      let report = false;
      let stored = previous ?? current;
      if (previous === undefined) {
        report = true;
      } else if (current < previous) {
        // 時計が戻った。戻り幅の分だけ黙り続けないよう、いまの時刻を最後の報告として置き直す (再開は最大でも intervalMs 後)。
        stored = current;
      } else if (current - previous >= intervalMs) {
        report = true;
        stored = current;
      }
      lastReported.delete(key);
      lastReported.set(key, stored);
      if (lastReported.size > maxKeys) {
        const oldest = lastReported.keys().next().value;
        if (oldest !== undefined) lastReported.delete(oldest);
      }
      return report;
    },
    forget(key) {
      lastReported.delete(key);
    },
    size() {
      return lastReported.size;
    },
  };
}
