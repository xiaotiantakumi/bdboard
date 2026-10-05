import { describe, expect, it } from 'vitest';
import { MIN_SAMPLE_MS, cpuTimeMs, defaultMinSampleMs } from './linear-time-test-support.js';

// bdboard-ncbb (PR #890 の再レビュー NIT-a): linear-time-test-support.ts の「1 回の測定の合計の下限」(minSampleMs の既定) が、
// CPU 時計の分解能の 10 倍以上であることを固定する。win32 の 160 を 30 に戻しても、Linux / macOS の CI では他のどのテストも
// 落ちない (30 は Linux / macOS の値なので正しい)。この退行は Windows でしか現れず、現れたときの症状は線形テストの偶発的な
// 失敗 (時計の刻みの揺れで比が散る) なので、原因を後から辿りにくい。

/** Windows の CPU 時間 (GetProcessTimes) の刻み。クロック tick の約 15.625ms。 */
const WINDOWS_CPU_TICK_MS = 15.625;

/**
 * CPU 時計が進むまで空回しして、進み幅の最小を分解能とする (µs の時計なら数 µs、Windows なら約 15.6ms)。
 * 6 回進むのを見る。Windows でも CPU 時間を使い続ける間の約 100ms で済む。
 * 時計がいつまでも進まないとき (壁時計で 5 秒) は Infinity を返し、呼び出し側の比較が落ちる。
 */
function measureCpuClockResolutionMs(): number {
  const deadline = performance.now() + 5_000;
  let smallest = Infinity;
  let previous = cpuTimeMs();
  let changes = 0;
  while (changes < 6) {
    const now = cpuTimeMs();
    if (now > previous) {
      smallest = Math.min(smallest, now - previous);
      previous = now;
      changes += 1;
    } else if (performance.now() > deadline) {
      break;
    }
  }
  return smallest;
}

describe('the default size of one measurement (minSampleMs)', () => {
  it('is at least 10 ticks of the Windows CPU clock when the platform is win32, on any platform this runs on', () => {
    expect(defaultMinSampleMs('win32')).toBeGreaterThanOrEqual(10 * WINDOWS_CPU_TICK_MS);
  });

  it('is shorter on the platforms with a fine CPU clock, so that the light tests stay quick', () => {
    expect(defaultMinSampleMs('linux')).toBeLessThan(defaultMinSampleMs('win32'));
    expect(defaultMinSampleMs('darwin')).toBe(defaultMinSampleMs('linux'));
  });

  it('follows the platform of this process', () => {
    expect(MIN_SAMPLE_MS).toBe(defaultMinSampleMs(process.platform));
  });

  // 実測: この環境の CPU 時計の分解能。Windows の CI では約 15.6ms (>= 156ms が要る) を測る。
  it('is at least 10 times the measured resolution of the CPU clock of this machine', () => {
    const resolution = measureCpuClockResolutionMs();
    expect(resolution, 'the CPU clock must move while this test keeps the CPU busy').toBeLessThan(Infinity);
    expect(MIN_SAMPLE_MS, `the resolution of the CPU clock here is ${resolution.toFixed(3)}ms`).toBeGreaterThanOrEqual(10 * resolution);
  });
});
