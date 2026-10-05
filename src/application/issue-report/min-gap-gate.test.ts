import { describe, expect, it } from 'vitest';
import { createMinGapGate } from './min-gap-gate.js';

describe('minimum gap gate', () => {
  it('allows the first request and reports retry time without extending the gap', () => {
    let now = 0;
    const gate = createMinGapGate({ minGapMs: 60_000, now: () => now });
    expect(gate.tryPass()).toEqual({ ok: true });
    now = 20_000;
    expect(gate.tryPass()).toEqual({ ok: false, retryAfterMs: 40_000 });
    now = 59_999;
    expect(gate.tryPass()).toEqual({ ok: false, retryAfterMs: 1 });
    now = 60_000;
    expect(gate.tryPass()).toEqual({ ok: true });
  });
});
