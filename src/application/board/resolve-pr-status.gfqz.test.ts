import { describe, expect, it, vi } from 'vitest';
import { Semaphore } from '../concurrency.js';
import { resolvePrStatus, type PrStatusBudget } from './resolve-pr-status.js';
import { PrBadgeStatusCache } from './pr-badge-status-cache.js';
import type { PrStatusReader } from '../ports/pr-status-reader.js';

// bdboard-gfqz: statusGate.acquire() が deps.getPriority() の戻り値をそのまま渡す
// ことを直接検証する。Semaphore 自体のスケジューリング契約は
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

describe('resolvePrStatus: getPriority is forwarded to statusGate.acquire (bdboard-gfqz)', () => {
  it('passes the getPriority() result when statusCache is not provided (direct-fetch branch)', async () => {
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

    expect(acquireSpy).toHaveBeenCalledWith('low');
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

    expect(acquireSpy).toHaveBeenCalledWith('high');
  });

  it('passes the getPriority() result via the fetchStatus in-flight-launcher branch (statusCache provided)', async () => {
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

    expect(acquireSpy).toHaveBeenCalledWith('low');
  });
});
