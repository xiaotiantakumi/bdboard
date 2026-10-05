import { describe, expect, it } from 'vitest';
import {
  cpuTimeMs,
  expectLinearTime,
  measureLinearTime,
  type LinearTimeSetup,
} from './linear-time-test-support.js';

// bdboard-0101: 補助自身の検査。負荷に左右されないよう、時計は偽物 (run が進めた分だけ進む) を差す。
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

describe('expectLinearTime', () => {
  it('passes when the time grows with the length (a ratio of about 10 for a 1/10 small run)', () => {
    const clock = fakeClock();
    const report = expectLinearTime('linear', (n) => {
      const count = n(BIG);
      return () => clock.advance(count * 0.01);
    }, { clock: clock.now });
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
    expect(() => expectLinearTime('quadratic', setup, { clock: clock.now })).toThrowError(
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
    }, { clock: clock.now });
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
    const report = measureLinearTime('quadratic with one spike', setup, { clock: clock.now });
    expect(report.attempts).toBe(3);
    expect(report.bigMs).toBeCloseTo(1000, 6);
    expect(report.ratio).toBeCloseTo(100, 6);
    expect(() => expectLinearTime('quadratic with one spike', setup, { clock: clock.now })).toThrowError(/ratio=100\.0/);
  });

  it('fails on the absolute limit even when the ratio is linear', () => {
    const clock = fakeClock();
    const setup: LinearTimeSetup = (n) => {
      const count = n(BIG);
      return () => clock.advance(count * 0.4);
    };
    expect(() => expectLinearTime('slow but linear', setup, { clock: clock.now })).toThrowError(
      /the big run must stay under the absolute limit of 30000ms: slow but linear: small=4000\.0ms big=40000\.0ms ratio=10\.0/,
    );
    expect(() => expectLinearTime('slow but linear', setup, { clock: clock.now, maxAbsoluteMs: 50_000 })).not.toThrow();
  });

  it('does not repeat a big run of 10 seconds or more, which a load spike cannot explain', () => {
    const clock = fakeClock();
    const setup: LinearTimeSetup = (n) => {
      const count = n(BIG);
      return () => clock.advance((count * count) / 1e6);
    };
    const report = measureLinearTime('long quadratic', setup, { clock: clock.now });
    expect(report.bigMs).toBeCloseTo(10_000, 6);
    expect(report.attempts).toBe(1);
  });

  it('divides by a floor when the small run is faster than the timer and scheduler can resolve', () => {
    const clock = fakeClock();
    const setup: LinearTimeSetup = (n) => {
      const count = n(BIG);
      return () => clock.advance(count * 0.00003);
    };
    // small 0.3ms, big 3ms: 10x, and 0.6x once the floor of 5ms is applied.
    expect(measureLinearTime('tiny', setup, { clock: clock.now }).ratio).toBeCloseTo(0.6, 6);
    expect(measureLinearTime('tiny', setup, { clock: clock.now, minSmallMs: 0.05 }).ratio).toBeCloseTo(10, 6);
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
    expect(measureLinearTime('tiny with a stall', stallOnce, { clock: clock.now, maxAttempts: 1 }).ratio).toBeLessThan(25);
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
    }, { clock: clock.now });
    expect(report.ratio).toBeCloseTo(10, 6);
    // 小 3 回 (1/10) の後に大 1 回 (そのまま)。小さくても 1 以上。
    expect(counts).toEqual([10_000, 300, 10_000, 300, 10_000, 300, 100_000, 3_000]);
  });

  it('reads the CPU time of this process by default, which never goes back', () => {
    const before = cpuTimeMs();
    let sink = 0;
    for (let index = 0; index < 3_000_000; index += 1) sink += index % 7;
    const after = cpuTimeMs();
    expect(sink).toBeGreaterThan(0);
    expect(after).toBeGreaterThanOrEqual(before);
    // 既定の時計で、線形の (時間が長さに比例する) 実走も通る。
    const report = expectLinearTime('real clock', (n) => {
      const count = n(3_000_000);
      return () => {
        let total = 0;
        for (let index = 0; index < count; index += 1) total += index % 7;
        expect(total).toBeGreaterThan(0);
      };
    });
    expect(report.attempts).toBeGreaterThanOrEqual(1);
  });
});
