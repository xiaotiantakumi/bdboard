/**
 * mainWork を overallTimeoutMs でレースする。get-pr-badges.ts から切り出した
 * (bdboard-se3v: 挙動変更ついでの行数上限対応。ロジックは1文字も変えていない)。
 * 期限超過時も mainWork 自体はキャンセルしない (裏でキャッシュを温め続けさせるため)
 * —— 戻り値の真偽だけで「打ち切ったか」を呼び出し元に伝える。
 */
export async function raceWithOverallTimeout(
  mainWork: Promise<void>,
  overallTimeoutMs: number,
): Promise<boolean> {
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutSignal = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      resolve();
    }, overallTimeoutMs);
  });
  try {
    await Promise.race([mainWork, timeoutSignal]);
  } finally {
    // mainWork が reject しても timer を必ず片付ける (opus レビューで指摘 —
    // bdboard-se3v)。runTicket は内部で失敗を握り潰すので今は起こらないはずだが、
    // 将来 mainWork の作りが変わったときのリーク防止として finally にしておく。
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
  return timedOut;
}
