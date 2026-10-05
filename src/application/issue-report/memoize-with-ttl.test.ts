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

  // bdboard-ov0t (#889 のレビュー NIT-5): 終わらない読み込みを期限なく共有すると、以後のすべての呼び出しが同じ promise を待ち続ける。
  it('shares an in-flight load only until the TTL passes, so a load that never settles is not shared for ever', () => {
    let time = 0;
    const load = vi.fn(() => new Promise<number>(() => undefined));
    const get = memoizeAsyncWithTtl(load, 30, () => time);
    const first = get();
    time = 29;
    expect(get()).toBe(first);
    expect(load).toHaveBeenCalledTimes(1);
    time = 30; // ちょうど期限は共有しない
    const second = get();
    expect(second).not.toBe(first);
    expect(load).toHaveBeenCalledTimes(2);
    time = 30 + 24 * 60 * 60 * 1000; // 1 日進めても、毎回 1 回に張り付かない
    get();
    expect(load).toHaveBeenCalledTimes(3);
  });

  it('does not share an in-flight load when the clock moved backwards', () => {
    let time = 100;
    const load = vi.fn(() => new Promise<number>(() => undefined));
    const get = memoizeAsyncWithTtl(load, 30, () => time);
    get();
    time = 90;
    get();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('keeps sharing the load that replaced an expired one, and a late old load neither overwrites it nor loses its own caller value', async () => {
    let time = 0;
    const resolvers: Array<(value: string) => void> = [];
    const load = vi.fn(() => new Promise<string>((resolve) => { resolvers.push(resolve); }));
    const get = memoizeAsyncWithTtl(load, 30, () => time);
    const old = get();
    time = 31;
    const fresh = get();
    expect(get()).toBe(fresh);
    expect(load).toHaveBeenCalledTimes(2);
    resolvers[1]?.('new');
    expect(await fresh).toBe('new');
    resolvers[0]?.('old');
    expect(await old).toBe('old'); // 古い読み込みの呼び出し側には、その値が返る
    time = 32;
    expect(await get()).toBe('new'); // 覚えているのは新しい読み込みの値
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('does not remember the value of an old load that settles while the replacing load is still running', async () => {
    let time = 0;
    const resolvers: Array<(value: string) => void> = [];
    const load = vi.fn(() => new Promise<string>((resolve) => { resolvers.push(resolve); }));
    const get = memoizeAsyncWithTtl(load, 30, () => time);
    const old = get();
    time = 31;
    const fresh = get();
    resolvers[0]?.('old');
    await old;
    time = 32;
    expect(get()).toBe(fresh); // 新しい読み込みがまだ進行中。古い値で割り込まない
    expect(load).toHaveBeenCalledTimes(2);
    resolvers[1]?.('new');
    expect(await fresh).toBe('new');
  });
});
