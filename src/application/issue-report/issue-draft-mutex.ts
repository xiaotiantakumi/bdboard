/** 呼び出しを 1 本ずつ直列に流す。受け取り・見送り・画像追加の「確認してから書く」を割り込ませない。 */
export function createMutex(): <T>(fn: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return (fn) => {
    const result = tail.then(fn);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
}
