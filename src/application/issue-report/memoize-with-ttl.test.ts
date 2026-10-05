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

  // bdboard-pvff: 古い読み込みが先に終わったとき、新しい値がまだ無ければ古い値を覚える。覚えないと、読み込みが毎回 TTL より長いとき値が一度も覚えられない。
  it('remembers the value of a replaced load that settles first, and the replacing load takes its place when it settles', async () => {
    let time = 0;
    const resolvers: Array<(value: string) => void> = [];
    const load = vi.fn(() => new Promise<string>((resolve) => { resolvers.push(resolve); }));
    const get = memoizeAsyncWithTtl(load, 30, () => time);
    const old = get();
    time = 31;
    const fresh = get();
    resolvers[0]?.('old');
    await old;
    time = 40; // 古い読み込みが終わってから 9 (期限の内)
    const hit = get();
    expect(hit).not.toBe(fresh); // 新しい読み込みの完了を待たず、覚えた古い値で答える
    expect(await hit).toBe('old');
    expect(load).toHaveBeenCalledTimes(2);
    resolvers[1]?.('new');
    expect(await fresh).toBe('new');
    expect(await get()).toBe('new'); // 新しい読み込みが終われば、その値に置き換わる
    expect(load).toHaveBeenCalledTimes(2);
  });

  // bdboard-pvff (#895 のレビュー O1): 読み込みが毎回 TTL より長いとき、どの読み込みも置き換えられてから終わり、値が一度も覚えられなかった。
  it('caches the value of a load that always takes longer than the TTL (loads take 45, TTL 30, a call every 10)', async () => {
    let time = 0;
    const settles: Array<{ at: number; resolve: (value: number) => void }> = [];
    const load = vi.fn(
      () =>
        new Promise<number>((resolve) => {
          settles.push({ at: time + 45, resolve });
        }),
    );
    const get = memoizeAsyncWithTtl(load, 30, () => time);
    let calls = 0;
    for (time = 0; time <= 600; time += 10) {
      for (const due of settles.filter((entry) => entry.at <= time)) due.resolve(due.at);
      settles.splice(0, settles.length, ...settles.filter((entry) => entry.at > time));
      await Promise.resolve(); // 値を覚える処理が走る
      await Promise.resolve();
      void get();
      calls += 1;
    }
    expect(calls).toBe(61);
    // 読み込みを始めるのは 0・30 / 110・140 / 220・250 / 330・360 / 440・470 / 550・580 の 12 回 (進行中の共有の期限 30 で 1 つ目が
    // 置き換えられ、2 つ目が終わるまでの間に 1 つ目の値が覚えられて、110 まで読まない)。覚えられないと、TTL ごとに読み直して 21 回になる。
    expect(load).toHaveBeenCalledTimes(12);
  });

  it('does not forget the replacing load when the old load fails', async () => {
    let time = 0;
    const loads: Array<{ resolve: (value: string) => void; reject: (error: Error) => void }> = [];
    const load = vi.fn(() => new Promise<string>((resolve, reject) => { loads.push({ resolve, reject }); }));
    const get = memoizeAsyncWithTtl(load, 30, () => time);
    const old = get();
    time = 31;
    const fresh = get();
    loads[0]?.reject(new Error('old failed'));
    await expect(old).rejects.toThrow('old failed');
    time = 32;
    expect(get()).toBe(fresh); // 置き換えた新しい読み込みは、古い読み込みの失敗で手放さない
    expect(load).toHaveBeenCalledTimes(2);
    loads[1]?.resolve('new');
    expect(await fresh).toBe('new');
    expect(await get()).toBe('new');
    expect(load).toHaveBeenCalledTimes(2);
  });

  // 「新しい」は時計ではなく読み込みを始めた順で決める: 時計が戻ると、あとから始めた読み込みの startedAt のほうが小さくなる。
  it('orders loads by when they started, not by the clock, so a load started after the clock moved back is the newer one', async () => {
    let time = 100;
    const resolvers: Array<(value: string) => void> = [];
    const load = vi.fn(() => new Promise<string>((resolve) => { resolvers.push(resolve); }));
    const get = memoizeAsyncWithTtl(load, 30, () => time);
    const first = get();
    time = 90; // 時計が戻る: 共有せず、新しく読み始める (こちらが新しい)
    const second = get();
    expect(load).toHaveBeenCalledTimes(2);
    resolvers[1]?.('second');
    expect(await second).toBe('second');
    resolvers[0]?.('first');
    expect(await first).toBe('first');
    expect(await get()).toBe('second'); // 先に始めた読み込みが、あとから終わっても、新しい値を上書きしない
    expect(load).toHaveBeenCalledTimes(2);
  });

  // 置き換えられた古い読み込みが成功で終わっても (値は新しいほうが覚えているので捨てる)、進行中の新しい読み込みは手放さない。
  it('does not forget the in-flight load when a replaced old load succeeds after a newer value was remembered', async () => {
    let time = 0;
    const resolvers: Array<(value: string) => void> = [];
    const load = vi.fn(() => new Promise<string>((resolve) => { resolvers.push(resolve); }));
    const get = memoizeAsyncWithTtl(load, 30, () => time);
    const first = get();
    time = 30; // 1 つ目の共有の期限
    const second = get();
    time = 35;
    resolvers[1]?.('second');
    expect(await second).toBe('second');
    time = 65; // 2 つ目の値の期限
    const third = get();
    expect(load).toHaveBeenCalledTimes(3);
    time = 70;
    resolvers[0]?.('first');
    expect(await first).toBe('first'); // 2 つ目の値のほうが新しいので覚えない
    time = 75;
    expect(get()).toBe(third); // 3 つ目はまだ進行中で、共有の期限の内
    expect(load).toHaveBeenCalledTimes(3);
    resolvers[2]?.('third');
    expect(await get()).toBe('third');
  });

  // 新しい読み込みの失敗は、覚えている (期限の内の) 古い値を消さない。
  it('keeps serving the remembered value of a replaced load when the replacing load fails', async () => {
    let time = 0;
    const loads: Array<{ resolve: (value: string) => void; reject: (error: Error) => void }> = [];
    const load = vi.fn(() => new Promise<string>((resolve, reject) => { loads.push({ resolve, reject }); }));
    const get = memoizeAsyncWithTtl(load, 30, () => time);
    const old = get();
    time = 31;
    const fresh = get();
    loads[0]?.resolve('old');
    expect(await old).toBe('old');
    loads[1]?.reject(new Error('new failed'));
    await expect(fresh).rejects.toThrow('new failed');
    time = 40; // 古い値を覚えてから 9 (期限の内)
    const hit = get();
    expect(load).toHaveBeenCalledTimes(2); // 読み直さない
    expect(await hit).toBe('old');
  });
});
