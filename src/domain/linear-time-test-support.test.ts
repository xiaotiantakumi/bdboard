import { describe, expect, it } from 'vitest';
import {
  cpuTimeMs,
  expectLinearTime,
  measureLinearTime,
  type LinearTimeOptions,
  type LinearTimeSetup,
} from './linear-time-test-support.js';

// bdboard-0101: 補助自身の検査。負荷に左右されないよう、時計は偽物 (run が進めた分だけ進む) を差す。
// 偽の時計の run は 1 回で ms 単位の時間を進めるので、繰り返し (minSampleMs) は止めて、1 回ずつ測る。
function fakeClock() {
  let time = 0;
  return {
    now: () => time,
    advance: (ms: number) => {
      time += ms;
    },
  };
}

const BIG = 100_000;

const once = (clock: { now: () => number }, extra: LinearTimeOptions = {}): LinearTimeOptions => ({
  clock: clock.now,
  minSampleMs: 0,
  ...extra,
});

/** run が cost(kind, 今までの大の回数) だけ偽の時計を進める。 */
function fakeRuns(cost: (kind: 'small' | 'big', bigRunsSoFar: number) => number) {
  let time = 0;
  let bigRuns = 0;
  const setup: LinearTimeSetup = (n) => {
    const isBig = n(BIG) === BIG;
    return () => {
      if (isBig) {
        time += cost('big', bigRuns);
        bigRuns += 1;
      } else time += cost('small', bigRuns);
    };
  };
  return { setup, clock: () => time };
}

describe('expectLinearTime', () => {
  it('passes when the time grows with the length (a ratio of about 10 for a 1/10 small run)', () => {
    const clock = fakeClock();
    const report = expectLinearTime('linear', (n) => {
      const count = n(BIG);
      return () => clock.advance(count * 0.01);
    }, once(clock));
    expect(report.smallMs).toBeCloseTo(100, 6);
    expect(report.bigMs).toBeCloseTo(1000, 6);
    expect(report.ratio).toBeCloseTo(10, 6);
    expect(report.attempts).toBe(1);
  });

  it('fails with the measured numbers when the time grows with the square of the length', () => {
    const clock = fakeClock();
    const setup: LinearTimeSetup = (n) => {
      const count = n(BIG);
      return () => clock.advance((count * count) / 1e7);
    };
    expect(() => expectLinearTime('quadratic', setup, once(clock))).toThrowError(
      /the big run must stay within 25x of the small run: quadratic: small=10\.0ms big=1000\.0ms ratio=100\.0 attempts=3/,
    );
  });

  it('measures again after a load spike that hits only one big run, and compares the minimums', () => {
    const clock = fakeClock();
    let bigRuns = 0;
    const report = expectLinearTime('spike on the first big run', (n) => {
      const count = n(BIG);
      const isBig = count === BIG;
      return () => {
        clock.advance(count * 0.01);
        if (isBig) {
          bigRuns += 1;
          if (bigRuns === 1) clock.advance(5000);
        }
      };
    }, once(clock));
    expect(report.attempts).toBe(2);
    expect(report.bigMs).toBeCloseTo(1000, 6);
    expect(report.ratio).toBeCloseTo(10, 6);
  });

  it('does not let a retry hide a quadratic one: the minimum of the big runs stays quadratic', () => {
    const clock = fakeClock();
    let bigRuns = 0;
    const setup: LinearTimeSetup = (n) => {
      const count = n(BIG);
      return () => {
        // 1 回目の大だけ負荷の山で遅く、2 回目以降は素の 2 次の時間。
        bigRuns += count === BIG ? 1 : 0;
        clock.advance((count * count) / 1e7 + (count === BIG && bigRuns === 1 ? 3000 : 0));
      };
    };
    const report = measureLinearTime('quadratic with one spike', setup, once(clock));
    expect(report.attempts).toBe(3);
    expect(report.bigMs).toBeCloseTo(1000, 6);
    expect(report.ratio).toBeCloseTo(100, 6);
    expect(() => expectLinearTime('quadratic with one spike', setup, once(clock))).toThrowError(/ratio=100\.0/);
  });

  it('fails on the absolute limit even when the ratio is linear', () => {
    const clock = fakeClock();
    const setup: LinearTimeSetup = (n) => {
      const count = n(BIG);
      return () => clock.advance(count * 0.4);
    };
    expect(() => expectLinearTime('slow but linear', setup, once(clock))).toThrowError(
      /the big run must stay under the absolute limit of 30000ms: slow but linear: small=4000\.0ms big=40000\.0ms ratio=10\.0/,
    );
    expect(() => expectLinearTime('slow but linear', setup, once(clock, { maxAbsoluteMs: 50_000 }))).not.toThrow();
    // 比が線形でも、小さい絶対の上限を渡せば (長さに依らない遅さを見たいテスト) 落ちる。
    expect(() => expectLinearTime('slow but linear', setup, once(clock, { maxAbsoluteMs: 10_000 }))).toThrowError(
      /the big run must stay under the absolute limit of 10000ms/,
    );
  });

  it('does not repeat a big run of 10 seconds or more, which a load spike cannot explain', () => {
    const clock = fakeClock();
    const setup: LinearTimeSetup = (n) => {
      const count = n(BIG);
      return () => clock.advance((count * count) / 1e6);
    };
    const report = measureLinearTime('long quadratic', setup, once(clock));
    expect(report.bigMs).toBeCloseTo(10_000, 6);
    expect(report.attempts).toBe(1);
  });

  it('divides by the optional floor minSmallMs, which is off by default', () => {
    const clock = fakeClock();
    const setup: LinearTimeSetup = (n) => {
      const count = n(BIG);
      return () => clock.advance(count * 0.00003);
    };
    // small 0.3ms, big 3ms: 10x by default, and 0.6x once a floor of 5ms is asked for.
    expect(measureLinearTime('tiny', setup, once(clock)).ratio).toBeCloseTo(10, 6);
    expect(measureLinearTime('tiny', setup, once(clock, { minSmallMs: 5 })).ratio).toBeCloseTo(0.6, 6);
    // A stall of 100ms in the big run alone: 103ms / 5ms floor = 20.6, under the limit of 25 (it would be 340 without the floor).
    let stalled = false;
    const stallOnce: LinearTimeSetup = (n) => {
      const count = n(BIG);
      return () => {
        clock.advance(count * 0.00003);
        if (count === BIG && !stalled) {
          stalled = true;
          clock.advance(100);
        }
      };
    };
    const report = measureLinearTime('tiny with a stall', stallOnce, once(clock, { minSmallMs: 5, maxAttempts: 1 }));
    expect(report.ratio).toBeCloseTo(20.6, 1);
  });

  it('builds the input outside the timed part and keeps the big run at the full length', () => {
    const clock = fakeClock();
    const counts: number[] = [];
    const report = expectLinearTime('setup is not timed', (n) => {
      clock.advance(1e6); // 入力の組み立て。計測には入らない。
      const count = n(BIG);
      const small = n(3_000);
      counts.push(count, small);
      return () => clock.advance(count * 0.01);
    }, once(clock));
    expect(report.ratio).toBeCloseTo(10, 6);
    // 小 3 回 (1/10) の後に大 1 回 (そのまま)。
    expect(counts).toEqual([10_000, 300, 10_000, 300, 10_000, 300, 100_000, 3_000]);
  });

  it('never scales a count below 1', () => {
    const seen: number[] = [];
    const clock = fakeClock();
    measureLinearTime('tiny count', (n) => {
      seen.push(n(4));
      return () => clock.advance(1);
    }, once(clock));
    expect(seen).toContain(1);
    expect(seen).not.toContain(0);
  });
});

// 時計の読み方 (最小を使う・上限ちょうど・測り直しの範囲) を固定する。
describe('measureLinearTime: which numbers are kept and when it measures again', () => {
  it('uses the fastest small run', () => {
    let time = 0;
    let smallRuns = 0;
    const report = measureLinearTime('noisy small', (n) => {
      const count = n(BIG);
      return () => {
        if (count !== BIG) {
          smallRuns += 1;
          time += smallRuns === 3 ? 500 : 100;
        } else time += 1000;
      };
    }, { clock: () => time, minSampleMs: 0 });
    expect(report.smallMs).toBe(100);
    expect(report.ratio).toBe(10);
  });

  it('reports the fastest big run across attempts', () => {
    const bigs = [2600, 3000, 2800];
    const { setup, clock } = fakeRuns((kind, done) => (kind === 'small' ? 100 : bigs[done]));
    const report = measureLinearTime('noisy big', setup, { clock, minSampleMs: 0 });
    expect(report.attempts).toBe(3);
    expect(report.bigMs).toBe(2600);
  });

  it('treats a ratio exactly at the limit as over it, and measures again', () => {
    const { setup, clock } = fakeRuns((kind) => (kind === 'small' ? 100 : 2500));
    expect(measureLinearTime('at the limit', setup, { clock, minSampleMs: 0 }).attempts).toBe(3);
  });

  it('measures the small run again on a retry, so a slow first small run does not hide a quadratic', () => {
    const { setup, clock } = fakeRuns((kind, done) => (kind === 'small' ? (done === 0 ? 200 : 100) : done === 0 ? 5000 : 4900));
    const report = measureLinearTime('slow first small', setup, { clock, minSampleMs: 0 });
    expect(report.smallMs).toBe(100);
    expect(report.ratio).toBe(49);
  });

  it('measures again against the maxRatio option, not the default', () => {
    const { setup, clock } = fakeRuns((kind) => (kind === 'small' ? 100 : 1000));
    expect(measureLinearTime('custom limit', setup, { clock, minSampleMs: 0, maxRatio: 5 }).attempts).toBe(3);
    expect(measureLinearTime('default limit', setup, { clock, minSampleMs: 0 }).attempts).toBe(1);
  });
});

// bdboard-0101 (PR #890 のレビュー): 軽い run は 1 回だけ測ると小が 1ms 前後になり、揺れで比が散る。
// 割る数に下限を置くと比が絶対値の検査になる。代わりに、合計が minSampleMs に届くまで繰り返して 1 回あたりを出す。
describe('measureLinearTime: repeating a light run until the sample is long enough', () => {
  it('repeats a run until the clock advanced by minSampleMs and reports the time of one run', () => {
    const clock = fakeClock();
    let smallRuns = 0;
    let bigRuns = 0;
    const report = measureLinearTime('light', (n) => {
      const isBig = n(BIG) === BIG;
      return () => {
        if (isBig) bigRuns += 1;
        else smallRuns += 1;
        clock.advance(isBig ? 1.25 : 0.125);
      };
    }, { clock: clock.now, minSampleMs: 30 });
    expect(report.smallMs).toBe(0.125);
    expect(report.bigMs).toBe(1.25);
    expect(report.ratio).toBe(10);
    expect(report.attempts).toBe(1);
    // 小は 3 回の測定で 30 / 0.125 = 240 回ずつ、大は 30 / 1.25 = 24 回。
    expect(smallRuns).toBe(3 * 240);
    expect(bigRuns).toBe(24);
  });

  it('measures once when minSampleMs is 0, or when one run already is long enough', () => {
    const clock = fakeClock();
    let runs = 0;
    const setup: LinearTimeSetup = (n) => {
      const count = n(BIG);
      return () => {
        runs += 1;
        clock.advance(count * 0.01);
      };
    };
    measureLinearTime('long runs', setup, { clock: clock.now, minSampleMs: 30 });
    expect(runs).toBe(3 + 1);
    runs = 0;
    measureLinearTime('no repeat', setup, { clock: clock.now, minSampleMs: 0 });
    expect(runs).toBe(3 + 1);
  });

  it('keeps the per-run time of a light run exact on a clock that only moves in coarse ticks (Windows: about 15.6ms)', () => {
    let time = 0;
    const tick = 15.625;
    const coarse = () => Math.floor(time / tick) * tick;
    const report = measureLinearTime('coarse clock', (n) => {
      const isBig = n(BIG) === BIG;
      return () => {
        time += isBig ? 1 : 0.1;
      };
    }, { clock: coarse, minSampleMs: 160 });
    // 刻みで切り上がる分 (合計 160ms に対して最大 1 刻み = 約 10%) の誤差は残る。1 回だけ測ると 0 か 15.6ms になる。
    expect(report.smallMs).toBeGreaterThan(0.09);
    expect(report.smallMs).toBeLessThan(0.12);
    expect(report.bigMs).toBeGreaterThan(0.9);
    expect(report.bigMs).toBeLessThan(1.2);
    expect(report.ratio).toBeGreaterThan(8);
    expect(report.ratio).toBeLessThan(12);
  });

  it('does not loop forever or divide by zero when the clock never moves', () => {
    const report = measureLinearTime('stuck clock', () => () => undefined, { clock: () => 0 });
    expect(report.smallMs).toBe(0);
    expect(report.bigMs).toBe(0);
    expect(report.ratio).toBe(0);
    expect(Number.isFinite(report.ratio)).toBe(true);
  });
});

describe('the default clock', () => {
  it('is the CPU time of this process, which never goes back', () => {
    const before = cpuTimeMs();
    let sink = 0;
    for (let index = 0; index < 3_000_000; index += 1) sink += index % 7;
    const after = cpuTimeMs();
    expect(sink).toBeGreaterThan(0);
    expect(after).toBeGreaterThanOrEqual(before);
  });

  // 眠っている間は CPU を使わない。壁時計に戻すと 300ms と測られて落ちる。CPU を使わない run は CPU 時間のサンプル下限に
  // 届かないので minSampleMs: 0 を渡す。
  it('does not count time the run spends asleep: it measures CPU time, not the wall clock', () => {
    const cell = new Int32Array(new SharedArrayBuffer(4));
    const report = measureLinearTime('sleeping big run', (n) => {
      const isBig = n(10) === 10;
      return () => {
        if (isBig) Atomics.wait(cell, 0, 0, 300);
      };
    }, { minSampleMs: 0, maxAttempts: 1 });
    expect(report.bigMs).toBeLessThan(50);
  });
});
