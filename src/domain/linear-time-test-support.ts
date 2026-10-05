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
 * 小と大で同じ割合で伸びるだけになる (異種コアの機械では近似)。
 *
 * 揺れへの備え:
 *   - 1 回の測定は、合計が `minSampleMs` (既定 30ms。Windows は CPU 時間の刻みが約 15.6ms なので 160ms) に届くまで
 *     同じ run を繰り返し、1 回あたりの時間を出す。入力の処理が軽いテスト (大でも 10〜50ms) では、1 回だけ測ると
 *     小が 1ms 前後になり、GC など別スレッドの CPU 時間や刻みの揺れで生の比が 5〜23 に散る。繰り返せばその揺れは
 *     消えて、生の比は 10 前後に揃う。以前は割る数に下限 (5ms) を置いていたが、下限は軽いテストの比を
 *     「大 < 125ms」という絶対値の検査に変えてしまい、2 次の混入を見逃した (PR #890 のレビュー)。
 *   - 小は何回か測って最小を使う (JIT の温まる前の 1 回目や、負荷の山に当たった回を捨てる)。
 *   - 比が上限に届いたら、小と大を測り直して最小どうしで比べる (最大 3 試行)。負荷の山が大の 1 回に
 *     だけ当たったときを拾うためで、2 次の実装なら何度測っても比は約 100 のままなので見逃さない。
 *   - 絶対の上限 (既定 30 秒、CPU 時間) は 2 次爆発を捕まえられる程度に緩く残す。切り詰めた後の処理のように
 *     入力の長さに依らない遅さは比に現れないので、それを見たいテストは小さい上限を渡す。
 *
 * 前提: 既定の時計 (CPU 時間) はプロセス全体の値なので、1 つのテストファイルが 1 つのプロセスで走ること
 * (vitest の既定の pool = forks) が要る。別スレッド (pool: threads) では他のファイルの CPU 時間が混ざるので、
 * 既定の時計では throw する。
 *
 * テストは呼び出し側が vitest の timeout に `LINEAR_TIME_TEST_TIMEOUT_MS` を明示する
 * (小 3 回 + 大 1〜3 回を測るので、負荷の中では既定の 5 秒に収まらないことがある。bdboard-jh6g の先例)。
 */
import { isMainThread } from 'node:worker_threads';
import { expect } from 'vitest';

/** 入力の「大きい繰り返し回数」を縮尺に合わせて返す関数。大の実行では恒等で、小の実行では 1 以上に丸めて縮める。 */
export type ScaleCount = (count: number) => number;

/**
 * 1 回分の入力を組み立て (計測に含めない)、計測する本体を返す。
 * 本体の中で結果の検査をしてよい (小・大のどちらの実行でも走る。軽いときは繰り返し呼ばれるので、
 * 本体は何度呼んでも同じ結果になること)。`scale` は長さを決める数だけに使い、
 * 形を決める小さな数 (`.repeat(3)` など) には使わない。
 *
 * 補助は測定ごとに `setup` を呼び直す (入力を測定の間で使い回さない)。使い回しは bdboard-4367 で測り、リンク数えの 4 つの形 x 2 対象
 * (30〜40 回の中央値) で、比は変わらないかわずかに高かった。一方、`repeat` が作る連結文字列 (rope) は最初の走査が平坦化 (コピー) を
 * 負担するので、その費用を計測から外すと 'many raw URLs' の比の中央値が 0.5〜0.9 下がった (ほかの形は変わらない)。外したいテストは
 * `setup` の中で入力を 1 度読んで (`text.charCodeAt(0)`) 平坦にしておく。
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
  /**
   * 1 回の測定の合計がこれに届くまで run を繰り返し、1 回あたりの時間を出す (ms)。
   * 既定は `MIN_SAMPLE_MS` (30、Windows は 160)。0 なら 1 回だけ測る。CPU を使わない run は
   * CPU 時間のこの下限にいつまでも届かないので、そういう run と、run の回数を数える自己テストは 0 を渡す。
   */
  readonly minSampleMs?: number;
  /** 比を出すときに小の時間がこれ未満ならこの値で割る (ms)。既定 0 (割る数の下限は置かない)。 */
  readonly minSmallMs?: number;
  /** 時計 (ms)。既定はこのプロセスが使った CPU 時間 (`cpuTimeMs`)。この補助自身のテストが偽の時計を差す。 */
  readonly clock?: () => number;
}

export interface LinearTimeReport {
  readonly label: string;
  /** 小の実行 1 回あたりの時間の最小 (ms)。 */
  readonly smallMs: number;
  /** 大の実行 1 回あたりの時間の最小 (ms)。 */
  readonly bigMs: number;
  /** bigMs / max(smallMs, minSmallMs, 0 除算を避ける下限)。 */
  readonly ratio: number;
  readonly attempts: number;
}

/**
 * vitest の timeout に渡す値 (壁時計)。大は最大 3 回 (`maxAttempts` は 1 回目を含む) で、大が CPU 時間で
 * `maxAbsoluteMs / 3` 以上なら測り直さない (既定の上限 30 秒なら 10 秒、`maxAbsoluteMs` を絞ったテストではその 3 分の 1。
 * build は 10_000 を渡すので 3.3 秒)。小 3 回 x 3 試行と、絶対の上限 30 秒の大が 1 回あっても収まる余裕を取る。
 * 同期のコードは vitest の timeout では中断できない。超過した場合は事後に報告されるだけである。
 */
export const LINEAR_TIME_TEST_TIMEOUT_MS = 90_000;

export const LINEAR_TIME_DEFAULT_MAX_RATIO = 25;
export const LINEAR_TIME_DEFAULT_MAX_ABSOLUTE_MS = 30_000;
/** 小の時間が 0 のとき (時計が進まなかったとき) に、比が 0 除算で NaN や Infinity にならないための下限 (ms)。 */
const MIN_DIVISOR_MS = 0.001;
/**
 * 1 回の測定の合計の下限の既定 (ms)。時計の分解能の 10 倍以上: Windows の CPU 時間は約 15.6ms 刻みなので 160。
 * 両方の値は linear-time-test-support.clock.test.ts が固定する (platform を引数に取るのは、どの OS で走っても
 * win32 の値を検査できるようにするため)。
 */
export function defaultMinSampleMs(platform: string): number {
  return platform === 'win32' ? 160 : 30;
}
export const MIN_SAMPLE_MS = defaultMinSampleMs(process.platform);
/** 繰り返しの上限。時計が進まない (または極端に軽い) run で無限に回らないための安全弁。 */
const MAX_REPS = 100_000;

const scaleBy =
  (factor: number): ScaleCount =>
  (count) =>
    factor === 1 ? count : Math.max(1, Math.round(count * factor));

/**
 * このプロセスが使った CPU 時間 (user + system、ms)。壁時計でなくこれを測る理由は先頭のコメント。
 * 分解能は Linux/macOS では µs。Windows は約 15ms 刻みで粗いが、`MIN_SAMPLE_MS` まで繰り返すので
 * 1 回あたりの時間は粗くならない。
 */
export function cpuTimeMs(): number {
  const usage = process.cpuUsage();
  return (usage.user + usage.system) / 1000;
}

function timeOnce(setup: LinearTimeSetup, factor: number, clock: () => number, minSampleMs: number): number {
  const run = setup(scaleBy(factor));
  const started = clock();
  let reps = 0;
  let elapsed: number;
  do {
    run();
    reps += 1;
    elapsed = clock() - started;
  } while (elapsed < minSampleMs && reps < MAX_REPS);
  return elapsed / reps;
}

/** 計測だけを行い、結果を返す (合否は付けない)。合否は `expectLinearTime`。 */
export function measureLinearTime(label: string, setup: LinearTimeSetup, options: LinearTimeOptions = {}): LinearTimeReport {
  const smallScale = options.smallScale ?? 0.1;
  const maxRatio = options.maxRatio ?? LINEAR_TIME_DEFAULT_MAX_RATIO;
  const maxAbsoluteMs = options.maxAbsoluteMs ?? LINEAR_TIME_DEFAULT_MAX_ABSOLUTE_MS;
  const minSampleMs = options.minSampleMs ?? MIN_SAMPLE_MS;
  const minSmallMs = options.minSmallMs ?? 0;
  const smallRuns = Math.max(1, options.smallRuns ?? 3);
  const maxAttempts = Math.max(1, options.maxAttempts ?? 3);
  if (options.clock === undefined && !isMainThread) {
    throw new Error(
      'linear-time-test-support: the default clock is the CPU time of the whole process, which is only the CPU time of ' +
        'this test when one test file runs per process (the vitest default pool, forks). Worker threads share it with ' +
        'other test files, so the ratio is meaningless here. Use the forks pool, or pass your own clock.',
    );
  }
  const clock = options.clock ?? cpuTimeMs;

  let smallMs = Infinity;
  let bigMs = Infinity;
  let ratio = Infinity;
  let attempts = 0;
  while (attempts < maxAttempts) {
    attempts += 1;
    // 小のすぐ後に大を測る (同じ負荷の中で比べる)。
    for (let run = 0; run < smallRuns; run += 1) smallMs = Math.min(smallMs, timeOnce(setup, smallScale, clock, minSampleMs));
    bigMs = Math.min(bigMs, timeOnce(setup, 1, clock, minSampleMs));
    ratio = bigMs / Math.max(smallMs, minSmallMs, MIN_DIVISOR_MS);
    if (ratio < maxRatio) break;
    // 大が絶対の上限の 3 分の 1 以上 (既定なら 10 秒級) と長いのは負荷の山では説明できず、測り直すとテストの timeout を食うだけなので止める。
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
