import { describe, expect, it, vi } from 'vitest';
import { expectLinearTime, measureLinearTime, type LinearTimeSetup } from './linear-time-test-support.js';

// bdboard-ncbb (PR #890 の再レビュー NIT-a): 既定の時計 (このプロセスの CPU 時間) は、worker thread の中では他のテストファイルの
// CPU 時間が混ざって比が意味を失うので、使おうとしたら throw する。isMainThread のガードを外しても、forks pool (既定) で走る
// 他のテストはすべて通る。ここでは `node:worker_threads` を差し替えて、worker thread の中にいる状態を作って固定する。
// モックはファイル単位なので、このファイルだけを別にしてある (isMainThread が false のままでは、既定の時計を使うテストは動かない)。
vi.mock('node:worker_threads', () => ({ isMainThread: false }));

/** 呼ばれた回数を数える setup (測り始める前に throw したことを見る)。 */
function countingSetup(): { readonly setup: LinearTimeSetup; readonly built: () => number } {
  let built = 0;
  return {
    setup: () => {
      built += 1;
      return () => undefined;
    },
    built: () => built,
  };
}

describe('the default clock in a worker thread', () => {
  it('refuses to measure with the CPU time of the process, before building or running anything', () => {
    const { setup, built } = countingSetup();
    expect(() => measureLinearTime('worker thread', setup)).toThrowError(/the default clock is the CPU time of the whole process/);
    expect(() => measureLinearTime('worker thread', setup)).toThrowError(/forks pool/);
    expect(built()).toBe(0);
  });

  it('refuses through expectLinearTime too', () => {
    const { setup, built } = countingSetup();
    expect(() => expectLinearTime('worker thread', setup)).toThrowError(/the default clock is the CPU time of the whole process/);
    expect(built()).toBe(0);
  });

  it('measures with a clock of its own', () => {
    let time = 0;
    const { setup, built } = countingSetup();
    const report = measureLinearTime('own clock', setup, { clock: () => (time += 1), minSampleMs: 0 });
    expect(report.attempts).toBe(1);
    expect(built()).toBe(3 + 1);
  });
});
