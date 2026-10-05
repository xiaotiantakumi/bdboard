import { describe, expect, it, vi } from 'vitest';
import { memoizeAsyncWithTtl } from './memoize-with-ttl.js';

describe('memoizeAsyncWithTtl', () => {
  it('reuses successful values until the TTL expires', async () => {
    let time = 0;
    const load = vi.fn(async () => load.mock.calls.length);
    const get = memoizeAsyncWithTtl(load, 30, () => time);
    expect(await get()).toBe(1);
    expect(await get()).toBe(1);
    time = 31;
    expect(await get()).toBe(2);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('shares concurrent loads and does not cache failures', async () => {
    let rejectLoad!: (error: Error) => void;
    const load = vi.fn(() => new Promise<number>((_resolve, reject) => { rejectLoad = reject; }));
    const get = memoizeAsyncWithTtl(load, 30, () => 0);
    const first = get();
    const second = get();
    expect(load).toHaveBeenCalledTimes(1);
    rejectLoad(new Error('failed'));
    await expect(first).rejects.toThrow('failed');
    await expect(second).rejects.toThrow('failed');
    const retry = get();
    expect(load).toHaveBeenCalledTimes(2);
    rejectLoad(new Error('failed again'));
    await expect(retry).rejects.toThrow('failed again');
  });

  it('expires the value when the clock moves backwards', async () => {
    let time = 100;
    const load = vi.fn(async () => load.mock.calls.length);
    const get = memoizeAsyncWithTtl(load, 30, () => time);
    await get();
    time = 90;
    await get();
    expect(load).toHaveBeenCalledTimes(2);
  });
});
