// bdboard-xw00 (2bif の残り): 着地後検証の間にマシンが眠っていた秒数を、監査ログだけに残す。
//
// 壁時計 (Date.now) はスリープ中も進み、単調時計 (performance.now = libuv の hrtime。macOS の
// CLOCK_UPTIME_RAW / Linux の CLOCK_MONOTONIC) はスリープ中に止まる。差が眠っていた時間の目安になる。
// 時刻合わせ (NTP) の揺れを拾わないよう、30 秒を超えたときだけ値を返す。再実行するかの判断には使わない
// (判断は green-tree.mjs の構造の証拠と、凍結した分類器だけ)。夜間の finish は caffeinate -is で眠らせない。
const THRESHOLD_SECONDS = 30;

/**
 * 経過時間 2 つ (壁時計・単調時計、ミリ秒) から眠っていた秒数を返す純関数。30 秒以下なら undefined
 * (audit は undefined の項目を出さない)。
 */
export function sleptSeconds(wallElapsedMs, monotonicElapsedMs) {
  const seconds = Math.round((wallElapsedMs - monotonicElapsedMs) / 1000);
  return seconds > THRESHOLD_SECONDS ? seconds : undefined;
}

/** いまから測り始め、呼ぶたびにそこまでの sleptSeconds を返す関数。 */
export function startSleepClock(now = () => ({ wall: Date.now(), monotonic: performance.now() })) {
  const start = now();
  return () => {
    const end = now();
    return sleptSeconds(end.wall - start.wall, end.monotonic - start.monotonic);
  };
}
