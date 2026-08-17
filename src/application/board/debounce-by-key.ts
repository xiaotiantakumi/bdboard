export interface DebouncedByKey<K> {
  /** キーに対する呼び出しを ms ミリ秒 debounce して1回にまとめる */
  trigger(key: K): void;
  /** 保留中のタイマーを全部クリアする(発火させない) */
  cancel(): void;
}

export function debounceByKey<K>(
  fn: (key: K) => void,
  ms: number,
): DebouncedByKey<K> {
  const timers = new Map<K, ReturnType<typeof setTimeout>>();

  return {
    trigger(key: K): void {
      const existing = timers.get(key);
      if (existing !== undefined) {
        clearTimeout(existing);
      }

      const timer = setTimeout(() => {
        timers.delete(key);
        fn(key);
      }, ms);
      timers.set(key, timer);
    },

    cancel(): void {
      for (const timer of timers.values()) {
        clearTimeout(timer);
      }
      timers.clear();
    },
  };
}
