import { describe, expect, it } from 'vitest';
import { createMinGapGate } from './min-gap-gate.js';

function createGate(minGapMs = 60_000) {
  let nowMs = 1_000_000;
  const gate = createMinGapGate({ minGapMs, now: () => nowMs });
  return {
    gate,
    advance(ms: number) {
      nowMs += ms;
    },
    set(ms: number) {
      nowMs = ms;
    },
  };
}

describe('createMinGapGate', () => {
  it('lets the first call through, however early it comes', () => {
    const { gate } = createGate();
    expect(gate.tryPass()).toEqual({ ok: true });
  });

  it('refuses a second call inside the gap and says how long is left', () => {
    const { gate, advance } = createGate();
    expect(gate.tryPass()).toEqual({ ok: true });

    expect(gate.tryPass()).toEqual({ ok: false, retryAfterMs: 60_000 });
    advance(15_000);
    expect(gate.tryPass()).toEqual({ ok: false, retryAfterMs: 45_000 });
    advance(44_999);
    expect(gate.tryPass()).toEqual({ ok: false, retryAfterMs: 1 });
  });

  it('lets a call through exactly one gap after the last one that passed', () => {
    const { gate, advance } = createGate();
    expect(gate.tryPass().ok).toBe(true);
    advance(60_000);
    expect(gate.tryPass().ok).toBe(true);
  });

  it('measures the next gap from the call that passed, and refused calls do not push it back', () => {
    const { gate, advance } = createGate();
    expect(gate.tryPass().ok).toBe(true);
    // 30 秒おきに連打しても、通れる時刻は最初の通過から 60 秒後のまま。
    advance(30_000);
    expect(gate.tryPass().ok).toBe(false);
    advance(29_999);
    expect(gate.tryPass().ok).toBe(false);
    advance(1);
    expect(gate.tryPass().ok).toBe(true);
    // 通ったので、次はその時刻から数え直す。
    advance(59_999);
    expect(gate.tryPass()).toEqual({ ok: false, retryAfterMs: 1 });
  });

  it('keeps refusing when the clock goes backwards (it does not hand out a free pass)', () => {
    const { gate, set } = createGate();
    expect(gate.tryPass().ok).toBe(true);
    set(0);
    expect(gate.tryPass().ok).toBe(false);
  });

  it('uses the gap it was given', () => {
    const { gate, advance } = createGate(5);
    expect(gate.tryPass().ok).toBe(true);
    advance(4);
    expect(gate.tryPass()).toEqual({ ok: false, retryAfterMs: 1 });
    advance(1);
    expect(gate.tryPass().ok).toBe(true);
  });
});
