/**
 * bdboard-0101: 「敵対的な長い入力でも線形時間 (2 次的な爆発が無い)」を検査するテスト補助。
 * *-test-support.ts なので本番コードからの import は src/test-support-import-guard.test.ts が止める。
 *
 * 壁時計の絶対値 (「3000ms 未満」) で線形性を見ると、並列 verify の負荷で素の約 1 秒が 3 秒を超えて落ちる
 * (#884 の着地後検証が 3339ms で落ちた)。目的は絶対速度ではなく増え方なので、同じ形の入力を
 * 小 (既定で 1/10 の長さ) と大 (元の長さ) で測り、「大 / 小」の比を見る。
 * 線形なら比は約 10、2 次なら約 100 になる。既定の上限 25 はその間に置いてある。
 *
 * 測るのは壁時計ではなく CPU 時間 (`cpuTimeMs`)。比にするだけでは負荷を相殺しきれない (bdboard-0101 の実測):
 * 10 コアの機械で 24 本を同時に走らせて load average 99 にしたとき、同じ測定 72 回の「大 / 小」は、壁時計だと
 * 2〜95 に散って (8 つの対象のうち 7 つで 25 を超える回があり、4 つでは 8 割前後が超えた) 線形でも落ち、
 * CPU 時間だと全対象で 5〜12 に収まった。負荷で CPU を取り合うと、短い小の実行は待たされずに終わる一方、
 * 長い大の実行は待ちを多く含むので、壁時計の比は線形でも上がる。CPU 時間は待ちを含まないので、
 * 小と大で同じ割合で伸びるだけになる。
 *
 * 揺れへの備え:
 *   - 小は何回か測って最小を使う (JIT の温まる前の 1 回目や、負荷の山に当たった回を捨てる)。
 *   - 比が上限に届いたら、小と大を測り直して最小どうしで比べる (最大 3 試行)。負荷の山が大の 1 回に
 *     だけ当たったときを拾うためで、2 次の実装なら何度測っても比は約 100 のままなので見逃さない。
 *   - 小が数 ms 未満のとき (入力の処理自体が軽いテスト。大でも 10〜50ms) は、GC など別スレッドの CPU 時間や
 *     タイマーの粒度の揺れが比を支配する (測定では生の比が 5〜23 に散った) ので、割る数に下限 (既定 5ms) を置く。2 次爆発で大が数百 ms を超えれば、この下限があっても比で落ちる。
 *   - 絶対の上限 (既定 30 秒) は 2 次爆発を捕まえられる程度に緩く残す。
 *
 * テストは呼び出し側が vitest の timeout に `LINEAR_TIME_TEST_TIMEOUT_MS` を明示する
 * (小 3 回 + 大 1〜3 回を測るので、負荷の中では既定の 5 秒に収まらないことがある。bdboard-jh6g の先例)。
 */
import { expect } from 'vitest';

/** 入力の「大きい繰り返し回数」を縮尺に合わせて返す関数。大の実行では恒等で、小の実行では 1 以上に丸めて縮める。 */
export type ScaleCount = (count: number) => number;

/**
 * 1 回分の入力を組み立て (計測に含めない)、計測する本体を返す。
 * 本体の中で結果の検査をしてよい (小・大のどちらの実行でも走る)。`scale` は長さを決める数だけに使い、
 * 形を決める小さな数 (`.repeat(3)` など) には使わない。
 */
export type LinearTimeSetup = (scale: ScaleCount) => () => void;

export interface LinearTimeOptions {
  /** 小の実行の縮尺。既定 0.1 (長さが 1/10。線形なら比は約 10、2 次なら約 100)。 */
  readonly smallScale?: number;
  /** 「大 / 小」の上限 (これ未満で合格)。既定 25。 */
  readonly maxRatio?: number;
  /** 大の実行 1 回の絶対の上限 (CPU 時間の ms)。既定 30_000。2 次爆発だけを捕まえる、負荷でまず超えない値。 */
  readonly maxAbsoluteMs?: number;
  /** 小を 1 回の試行で測る回数 (最小を使う)。既定 3。 */
  readonly smallRuns?: number;
  /** 比が上限に届いたときに測り直す最大の試行回数 (1 回目を含む)。既定 3。 */
  readonly maxAttempts?: number;
  /** 比を出すときに小の時間がこれ未満ならこの値で割る (ms)。既定 5。 */
  readonly minSmallMs?: number;
  /** 時計 (ms)。既定はこのプロセスが使った CPU 時間 (`cpuTimeMs`)。この補助自身のテストが偽の時計を差す。 */
  readonly clock?: () => number;
}

export interface LinearTimeReport {
  readonly label: string;
  /** 小の実行の最小 (ms)。 */
  readonly smallMs: number;
  /** 大の実行の最小 (ms)。 */
  readonly bigMs: number;
  /** bigMs / max(smallMs, minSmallMs)。 */
  readonly ratio: number;
  readonly attempts: number;
}

/**
 * vitest の timeout に渡す値。小 3 回と大 1〜3 回に加え、絶対の上限 30 秒の大が 1 回あっても収まる余裕を取る。
 * (大が 10 秒を超えたら測り直さないので、最悪でも 10 秒の大 3 回 + 30 秒の大 1 回 + 小で 90 秒を超えない。)
 */
export const LINEAR_TIME_TEST_TIMEOUT_MS = 90_000;

export const LINEAR_TIME_DEFAULT_MAX_RATIO = 25;
export const LINEAR_TIME_DEFAULT_MAX_ABSOLUTE_MS = 30_000;
export const LINEAR_TIME_DEFAULT_MIN_SMALL_MS = 5;

const scaleBy =
  (factor: number): ScaleCount =>
  (count) =>
    factor === 1 ? count : Math.max(1, Math.round(count * factor));

/**
 * このプロセスが使った CPU 時間 (user + system、ms)。壁時計でなくこれを測る理由は先頭のコメント。
 * vitest の既定の pool (forks) ではテストファイルごとに別プロセスなので、このプロセスの CPU 時間は
 * そのテストファイルの実行だけを数える。分解能は Linux/macOS では µs。Windows は約 15ms 刻みで粗いが、
 * その場合も `minSmallMs` の下限があるので、短い小が 0 と読めても比は割れない。
 */
export function cpuTimeMs(): number {
  const usage = process.cpuUsage();
  return (usage.user + usage.system) / 1000;
}

function timeOnce(setup: LinearTimeSetup, factor: number, clock: () => number): number {
  const run = setup(scaleBy(factor));
  const started = clock();
  run();
  return clock() - started;
}

/** 計測だけを行い、結果を返す (合否は付けない)。合否は `expectLinearTime`。 */
export function measureLinearTime(label: string, setup: LinearTimeSetup, options: LinearTimeOptions = {}): LinearTimeReport {
  const smallScale = options.smallScale ?? 0.1;
  const maxRatio = options.maxRatio ?? LINEAR_TIME_DEFAULT_MAX_RATIO;
  const maxAbsoluteMs = options.maxAbsoluteMs ?? LINEAR_TIME_DEFAULT_MAX_ABSOLUTE_MS;
  const minSmallMs = options.minSmallMs ?? LINEAR_TIME_DEFAULT_MIN_SMALL_MS;
  const smallRuns = Math.max(1, options.smallRuns ?? 3);
  const maxAttempts = Math.max(1, options.maxAttempts ?? 3);
  const clock = options.clock ?? cpuTimeMs;

  let smallMs = Infinity;
  let bigMs = Infinity;
  let ratio = Infinity;
  let attempts = 0;
  while (attempts < maxAttempts) {
    attempts += 1;
    // 小のすぐ後に大を測る (同じ負荷の中で比べる)。
    for (let run = 0; run < smallRuns; run += 1) smallMs = Math.min(smallMs, timeOnce(setup, smallScale, clock));
    bigMs = Math.min(bigMs, timeOnce(setup, 1, clock));
    ratio = bigMs / Math.max(smallMs, minSmallMs);
    if (ratio < maxRatio) break;
    // 大が長い (10 秒級) のは負荷の山では説明できず、測り直すとテストの timeout を食うだけなので止める。
    if (bigMs >= maxAbsoluteMs / 3) break;
  }
  return { label, smallMs, bigMs, ratio, attempts };
}

/** 同じ形の入力を小と大で測り、「大 / 小」が線形の範囲で、大が絶対の上限に収まることを検査する。 */
export function expectLinearTime(label: string, setup: LinearTimeSetup, options: LinearTimeOptions = {}): LinearTimeReport {
  const maxRatio = options.maxRatio ?? LINEAR_TIME_DEFAULT_MAX_RATIO;
  const maxAbsoluteMs = options.maxAbsoluteMs ?? LINEAR_TIME_DEFAULT_MAX_ABSOLUTE_MS;
  const report = measureLinearTime(label, setup, options);
  const detail =
    `${label}: small=${report.smallMs.toFixed(1)}ms big=${report.bigMs.toFixed(1)}ms ` +
    `ratio=${report.ratio.toFixed(1)} attempts=${report.attempts} ` +
    `(linear is about ${(1 / (options.smallScale ?? 0.1)).toFixed(0)}, quadratic about ${(1 / (options.smallScale ?? 0.1) ** 2).toFixed(0)})`;
  expect(report.ratio, `the big run must stay within ${maxRatio}x of the small run: ${detail}`).toBeLessThan(maxRatio);
  expect(report.bigMs, `the big run must stay under the absolute limit of ${maxAbsoluteMs}ms: ${detail}`).toBeLessThan(maxAbsoluteMs);
  return report;
}
