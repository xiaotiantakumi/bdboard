import { describe, expect, it, vi } from 'vitest';
import { Semaphore, type SemaphorePriority } from '../concurrency.js';
import { resolvePrStatus, type PrStatusBudget } from './resolve-pr-status.js';
import { PrBadgeStatusCache } from './pr-badge-status-cache.js';
import type { PrStatusReader } from '../ports/pr-status-reader.js';

// bdboard-gfqz: statusGate.acquire() に渡す関数が deps.getPriority() の戻り値を
// 返すことを直接検証する (acquire() は今や優先度そのものではなく、呼ぶたびに
// deps.getPriority() を呼び直す関数を受け取る —— concurrency.ts の Semaphore が
// permit を渡す瞬間に都度再評価するため)。Semaphore 自体のスケジューリング契約は
// concurrency.gfqz.test.ts、getPrBadges() までの配線は get-pr-badges.gfqz.test.ts
// を参照。

function makeReader(): PrStatusReader {
  return {
    getPrStatus: vi.fn(async () => ({ status: { state: 'open', checkStatus: 'pass' } }) as const),
  };
}

function noopCallbacks() {
  return { onDeferred: () => {}, onAttempt: () => {}, onFailure: () => {} };
}

function priorityPassedToAcquire(acquireSpy: ReturnType<typeof vi.spyOn>): SemaphorePriority {
  const getPriority = acquireSpy.mock.calls[0]?.[0] as (() => SemaphorePriority) | undefined;
  expect(typeof getPriority).toBe('function');
  return getPriority!();
}

describe('resolvePrStatus: getPriority is forwarded to statusGate.acquire (bdboard-gfqz)', () => {
  it('passes a function returning getPriority()\'s current result when statusCache is not provided (direct-fetch branch)', async () => {
    const statusGate = new Semaphore(1);
    const acquireSpy = vi.spyOn(statusGate, 'acquire');
    const budget: PrStatusBudget = { remaining: 10 };

    await resolvePrStatus('https://github.com/x/y/pull/1', {
      prStatusReader: makeReader(),
      statusGate,
      budget,
      getPriority: () => 'low',
      ...noopCallbacks(),
    });

    expect(priorityPassedToAcquire(acquireSpy)).toBe('low');
  });

  it('defaults to high priority when getPriority is not supplied (direct-fetch branch)', async () => {
    const statusGate = new Semaphore(1);
    const acquireSpy = vi.spyOn(statusGate, 'acquire');
    const budget: PrStatusBudget = { remaining: 10 };

    await resolvePrStatus('https://github.com/x/y/pull/2', {
      prStatusReader: makeReader(),
      statusGate,
      budget,
      ...noopCallbacks(),
    });

    expect(priorityPassedToAcquire(acquireSpy)).toBe('high');
  });

  it('passes a function returning getPriority()\'s current result via the fetchStatus in-flight-launcher branch (statusCache provided)', async () => {
    // Note: with no joiner registered on this URL, PrBadgeStatusCache.fetchStatus()'s
    // merged priority reduces to this single provider's own result, so this test cannot
    // by itself distinguish "raw getPriority passed through" from "merged priority of one
    // provider" — both look identical here. The merge behavior itself (multiple providers,
    // live re-reads, no cross-URL leakage) is covered directly by
    // pr-badge-status-cache.gfqz.test.ts, and the wiring that actually matters in
    // production — a joiner's priority reaching the launcher's queued Semaphore waiter —
    // is covered end-to-end by get-pr-badges.gfqz.test.ts's second it() (bdboard-gfqz B1).
    const statusGate = new Semaphore(1);
    const acquireSpy = vi.spyOn(statusGate, 'acquire');
    const budget: PrStatusBudget = { remaining: 10 };
    const statusCache = new PrBadgeStatusCache();

    await resolvePrStatus('https://github.com/x/y/pull/3', {
      prStatusReader: makeReader(),
      statusCache,
      statusGate,
      budget,
      getPriority: () => 'low',
      ...noopCallbacks(),
    });

    expect(priorityPassedToAcquire(acquireSpy)).toBe('low');
  });

  it('the function passed to acquire() re-reads getPriority() live rather than snapshotting it once (proves resolve-pr-status.ts defers the call — bdboard-gfqz)', async () => {
    const statusGate = new Semaphore(1);
    const acquireSpy = vi.spyOn(statusGate, 'acquire');
    const budget: PrStatusBudget = { remaining: 10 };
    let current: SemaphorePriority = 'high';

    await resolvePrStatus('https://github.com/x/y/pull/4', {
      prStatusReader: makeReader(),
      statusGate,
      budget,
      getPriority: () => current,
      ...noopCallbacks(),
    });

    const getPriority = acquireSpy.mock.calls[0]?.[0] as () => SemaphorePriority;
    expect(getPriority()).toBe('high');
    current = 'low';
    expect(getPriority()).toBe('low');
  });
});
