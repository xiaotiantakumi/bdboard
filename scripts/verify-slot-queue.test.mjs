// bdboard-ulxa.6: verify スロットの順番決め (verify-slot-queue.mjs の純関数) のテスト。
// 優先度の順序・飢餓防止 (仮想到着時刻)・並んだ時刻の引き継ぎ・stale・旧形式 holder との混在。
// 混在は「旧スクリプトの判定 (legacyRank < slots) をそのまま真似たプロセス」と新形式を乱数で
// 入り混ぜ、同時に走る本数が上限を超えないことを確かめる。
import { describe, expect, it } from 'vitest';

import { legacyRank, normalizePriority, planSlots, queueKey } from './verify-slot-queue.mjs';

const MIN = 60_000;
const T0 = 1_000_000_000;
const OPTIONS = { slots: 2, staleTtlMs: 30 * MIN, tierStepMs: 4 * MIN, maxSeniorityMs: 30 * MIN };

const v2 = (pid, joinedAt, priority = 'pr', extra = {}) => ({ v: 2, pid, joinedAt, cwd: '/fake', priority, ...extra });
const legacy = (pid, joinedAt) => ({ pid, joinedAt, cwd: '/fake' });
const plan = (holders, selfPid, now = T0 + MIN, overrides = {}) => planSlots(holders, { ...OPTIONS, ...overrides, selfPid, now });
const pids = (list) => list.map((holder) => holder.pid);

describe('normalizePriority', () => {
  it('keeps known priorities and falls back to pr', () => {
    expect(['landed', 'merge', 'pr'].map(normalizePriority)).toEqual(['landed', 'merge', 'pr']);
    expect([undefined, '', 'urgent', 'constructor', 3].map(normalizePriority)).toEqual(['pr', 'pr', 'pr', 'pr', 'pr']);
  });
});

describe('planSlots: priority order', () => {
  it('orders waiters that joined together as landed, merge, pr', () => {
    const holders = [v2(3, T0, 'pr'), v2(1, T0, 'merge'), v2(2, T0, 'landed')];
    const result = plan(holders, 3, T0 + 1, { slots: 1 });
    expect(pids(result.queue)).toEqual([2, 1, 3]);
    expect(plan(holders, 2, T0 + 1, { slots: 1 }).acquire).toBe(true);
    expect(plan(holders, 1, T0 + 1, { slots: 1 }).acquire).toBe(false);
    expect(result.position).toBe(3);
  });

  it('lets a later high-priority waiter pass a waiting pr run, but never a running one and never past the limit', () => {
    const holders = [
      v2(1, T0, 'pr', { acquiredAt: T0 }),
      v2(2, T0 + 1_000, 'pr', { acquiredAt: T0 + 1_000 }),
      v2(3, T0 + 2_000, 'pr'),
      v2(4, T0 + 60_000, 'merge'),
    ];
    const now = T0 + 90_000;
    expect(pids(plan(holders, 4, now).running)).toEqual([1, 2]);
    expect(plan(holders, 4, now).acquire).toBe(false); // 枠は埋まっている
    expect(pids(plan(holders, 4, now).queue)).toEqual([4, 3]);
    const oneDone = holders.filter((holder) => holder.pid !== 1);
    expect(plan(oneDone, 4, now).acquire).toBe(true);
    expect(plan(oneDone, 3, now).acquire).toBe(false);
  });

  it('never grants more than the free slots even when every waiter is top priority', () => {
    const holders = [v2(1, T0, 'pr', { acquiredAt: T0 }), ...[2, 3, 4, 5].map((pid) => v2(pid, T0 + pid, 'landed'))];
    const granted = [2, 3, 4, 5].filter((pid) => plan(holders, pid).acquire);
    expect(granted).toEqual([2]);
  });
});

describe('planSlots: starvation bound (virtual arrival time)', () => {
  it('lets a pr waiter go first once higher tiers arrive more than a tier step after it', () => {
    const step = OPTIONS.tierStepMs;
    const pr = v2(1, T0, 'pr');
    // merge は 1 段上 = step だけ早く着いた扱い。step より後に来た merge には抜かれない。
    expect(pids(plan([pr, v2(2, T0 + step + 1_000, 'merge')], 1, T0 + 10 * MIN, { slots: 1 }).queue)).toEqual([1, 2]);
    expect(pids(plan([pr, v2(2, T0 + step - 1_000, 'merge')], 1, T0 + 10 * MIN, { slots: 1 }).queue)).toEqual([2, 1]);
    // landed は 2 段上。
    expect(pids(plan([pr, v2(3, T0 + 2 * step + 1_000, 'landed')], 1, T0 + 10 * MIN, { slots: 1 }).queue)).toEqual([1, 3]);
    expect(pids(plan([pr, v2(3, T0 + 2 * step - 1_000, 'landed')], 1, T0 + 10 * MIN, { slots: 1 }).queue)).toEqual([3, 1]);
  });

  it('bounds how long a pr waiter can be overtaken by a stream of merge runs', () => {
    // 1 分おきに merge が並び続けても、pr が抜かれるのは tierStepMs の間に来たものだけ。
    const pr = v2(1, T0, 'pr');
    const merges = Array.from({ length: 20 }, (_, index) => v2(10 + index, T0 + (index + 1) * MIN, 'merge'));
    const queue = pids(plan([pr, ...merges], 1, T0 + 30 * MIN, { slots: 1 }).queue);
    expect(queue.indexOf(1)).toBe(merges.filter((merge) => merge.joinedAt < T0 + OPTIONS.tierStepMs).length);
  });
});

describe('queueKey: seniority (holder.since)', () => {
  it('moves a re-queued PR back to when it first queued, capped at maxSeniorityMs', () => {
    const options = { tierStepMs: OPTIONS.tierStepMs, maxSeniorityMs: OPTIONS.maxSeniorityMs };
    const base = queueKey(v2(1, T0, 'merge'), options);
    expect(queueKey(v2(1, T0, 'merge', { since: T0 - 5 * MIN }), options)).toBe(base - 5 * MIN);
    expect(queueKey(v2(1, T0, 'merge', { since: T0 - 3 * 60 * MIN }), options)).toBe(base - 30 * MIN);
    expect(queueKey(v2(1, T0, 'merge', { since: T0 + 5 * MIN }), options)).toBe(base); // 未来の since は無視
    expect(queueKey(v2(1, T0, 'merge', { since: 'yesterday' }), options)).toBe(base);
  });

  it('keeps a re-queued merge run ahead of a newer merge run', () => {
    const retried = v2(1, T0 + 5 * MIN, 'merge', { since: T0 });
    const newcomer = v2(2, T0 + 2 * MIN, 'merge');
    expect(pids(plan([newcomer, retried], 1, T0 + 6 * MIN, { slots: 1 }).queue)).toEqual([1, 2]);
  });
});

describe('planSlots: stale holders', () => {
  it('judges a running current-format holder by acquiredAt, not by how long it queued', () => {
    const now = T0 + 40 * MIN;
    const longQueueThenRan = v2(1, T0, 'pr', { acquiredAt: T0 + 35 * MIN });
    const hung = v2(2, T0 + 5 * MIN, 'pr', { acquiredAt: T0 + 5 * MIN });
    const result = plan([longQueueThenRan, hung, v2(3, now, 'pr')], 3, now);
    expect(pids(result.running)).toEqual([1]);
    expect(pids(result.stale)).toEqual([2]);
    expect(result.acquire).toBe(true);
  });

  it('judges legacy and waiting holders by joinedAt, and never treats itself as stale', () => {
    const now = T0 + 40 * MIN;
    const result = plan([legacy(1, T0), v2(2, T0 + 1_000, 'pr'), v2(3, T0 + 2_000, 'pr')], 3, now, { slots: 1 });
    expect(pids(result.stale)).toEqual([1, 2]);
    expect(result.acquire).toBe(true);
  });
});

describe('planSlots: mixing with legacy (bdboard-d48) holders', () => {
  it('infers that a legacy holder is running exactly when the old script would run it', () => {
    const holders = [legacy(1, T0), legacy(2, T0 + 1_000), legacy(3, T0 + 2_000), v2(4, T0 + 3_000, 'landed')];
    const result = plan(holders, 4);
    expect(pids(result.running)).toEqual([1, 2]);
    expect(legacyRank(holders[2], holders, T0 + MIN, OPTIONS.staleTtlMs)).toBe(2);
    expect(result.acquire).toBe(false);
  });

  it('does not let a current-format waiter pass an earlier legacy waiter (barrier)', () => {
    const holders = [
      legacy(1, T0),
      v2(2, T0 + 1_000, 'pr', { acquiredAt: T0 + 1_000 }),
      legacy(3, T0 + 2_000),
      v2(4, T0 + 3_000, 'landed'),
    ];
    expect(plan(holders, 4).acquire).toBe(false);
    expect(pids(plan(holders, 4).queue)).toEqual([3, 4]);
    // legacy 1 が抜けると legacy 3 の旧スクリプト上の順位が 1 になり、legacy 3 が走る
    // (landed の pid 4 が先に取ると、旧スクリプトの legacy 3 はそれを数えずに走って 3 本になる)。
    const afterOne = holders.slice(1);
    expect(pids(plan(afterOne, 4).running)).toEqual([2, 3]);
    expect(plan(afterOne, 4).acquire).toBe(false);
  });

  it('treats a holder with an unknown format version as legacy', () => {
    const result = plan([{ ...v2(1, T0, 'landed'), v: 99 }, v2(2, T0 + 1_000, 'landed')], 2, T0 + MIN, { slots: 1 });
    expect(pids(result.running)).toEqual([1]);
  });

  it('keeps running <= slots in randomized interleavings of old and new processes', () => {
    let seed = 12345;
    const random = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    const priorities = ['landed', 'merge', 'pr'];
    for (let trial = 0; trial < 200; trial += 1) {
      const slots = 1 + Math.floor(random() * 3);
      const holders = [];
      const runningPids = new Set();
      let now = T0;
      let nextPid = 1;
      for (let step = 0; step < 60; step += 1) {
        now += Math.floor(random() * 90_000);
        if (random() < 0.5) {
          const pid = nextPid++;
          holders.push(random() < 0.4 ? legacy(pid, now) : v2(pid, now, priorities[Math.floor(random() * 3)], random() < 0.3 ? { since: now - Math.floor(random() * 40 * MIN) } : {}));
        }
        // 走っているものが終わる / 待っているものが諦める (Ctrl-C・merge-pr の打ち切り) の両方を起こす。
        if (holders.length > 0 && random() < 0.4) {
          const pool = runningPids.size > 0 && random() < 0.7 ? [...runningPids] : holders.map((holder) => holder.pid);
          const done = pool[Math.floor(random() * pool.length)];
          runningPids.delete(done);
          holders.splice(holders.findIndex((holder) => holder.pid === done), 1);
        }
        // 各プロセスが順不同にポーリングする (1 回ずつ、その時点の holder 一覧を見て判断)。
        for (const holder of [...holders].sort(() => random() - 0.5)) {
          if (runningPids.has(holder.pid)) {
            continue;
          }
          const go = holder.v === 2 ? plan(holders, holder.pid, now, { slots, staleTtlMs: 365 * 24 * 60 * MIN }).acquire : legacyRank(holder, holders, now, 365 * 24 * 60 * MIN) < slots;
          if (go) {
            runningPids.add(holder.pid);
            if (holder.v === 2) {
              holder.acquiredAt = now;
            }
          }
        }
        expect(runningPids.size).toBeLessThanOrEqual(slots);
      }
    }
  });
});
