// bdboard-ulxa.6: verify スロットの順番決め (verify-slot-queue.mjs の純関数) のテスト。
// 優先度の順序・飢餓防止 (仮想到着時刻)・並んだ時刻の引き継ぎ・stale・旧形式 holder との混在。
// 混在は「旧スクリプトの判定 (legacyRank < slots) をそのまま真似たプロセス」と新形式を乱数で
// 入り混ぜ、同時に走る本数が上限を超えないことを確かめる。
import { describe, expect, it } from 'vitest';

import { legacyRank, MAX_SENIORITY_MS, normalizePriority, planSlots, queueKey, TIER_STEP_MS } from './verify-slot-queue.mjs';

const MIN = 60_000;
const T0 = 1_000_000_000;
const OPTIONS = { slots: 2, staleTtlMs: 30 * MIN, tierStepMs: TIER_STEP_MS, maxSeniorityMs: MAX_SENIORITY_MS };

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
    expect(queueKey(v2(1, T0, 'merge', { since: T0 - 3 * 60 * MIN }), options)).toBe(base - OPTIONS.maxSeniorityMs);
    expect(queueKey(v2(1, T0, 'merge', { since: T0 + 5 * MIN }), options)).toBe(base); // 未来の since は無視
    expect(queueKey(v2(1, T0, 'merge', { since: 'yesterday' }), options)).toBe(base);
  });

  it('orders a holder that re-joined by when it first queued (queuedAt)', () => {
    const options = { tierStepMs: OPTIONS.tierStepMs, maxSeniorityMs: OPTIONS.maxSeniorityMs };
    const first = v2(1, T0, 'pr', { queuedAt: T0 });
    expect(queueKey({ ...first, joinedAt: T0 + 20 * MIN }, options)).toBe(queueKey(first, options));
    expect(queueKey({ ...first, joinedAt: T0 + 20 * MIN, since: T0 - 5 * MIN }, options)).toBe(queueKey(first, options) - 5 * MIN);
    expect(queueKey({ ...first, queuedAt: T0 + 60 * MIN }, options)).toBe(queueKey(first, options)); // joinedAt より後の queuedAt は無視
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

  it('judges legacy and waiting holders by joinedAt, and never lists itself as stale', () => {
    const now = T0 + 40 * MIN;
    const result = plan([legacy(1, T0), v2(2, T0 + 1_000, 'pr'), v2(3, now - MIN, 'pr')], 3, now, { slots: 1 });
    expect(pids(result.stale)).toEqual([1, 2]);
    expect(result.acquire).toBe(true);
  });

  it('does not let a waiter that others already treat as stale take a slot until it re-joins (review of PR #749)', () => {
    // 他の holder から見えない (stale) 待ち手が自分の目では先頭だと、見えている待ち手と同時に取って
    // 上限を超える。自分が stale の年齢なら取らず、並び直してから (joinedAt = 今、queuedAt は元のまま) 取る。
    const now = T0 + 31 * MIN;
    const running = v2(1, now - 2 * MIN, 'pr', { acquiredAt: now - 2 * MIN });
    const oldWaiter = v2(2, T0, 'pr', { queuedAt: T0 });
    const fresh = v2(3, now - 1_000, 'landed');
    expect(plan([running, oldWaiter, fresh], 2, now).acquire).toBe(false);
    expect(plan([running, oldWaiter, fresh], 3, now).acquire).toBe(true);
    const rejoined = { ...oldWaiter, joinedAt: now - 1_000 };
    expect(plan([running, rejoined, fresh], 2, now).acquire).toBe(true); // 並び順は queuedAt のまま
    expect(plan([running, rejoined, fresh], 3, now).acquire).toBe(false);
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

  // bdboard-c4nc: 100 trials x 150 steps (旧設定) は単体 4.55s 中この 1 テストで 2.9〜3.1s 消費し、
  // 並列 verify の高負荷下 (他プロセスとの CPU 競合) で既定 5000ms を超えて落ちた (PR #763 の
  // predicted-verify で実測 5253ms)。real timer は使っていない (`now` はシミュレーション内の仮想時刻
  // で、await/setTimeout の類は無い) ので fake timer の注入では解決しない — 純粋に CPU 負荷が高い
  // ループそのものが原因。steps を 150→100 に落とすことで 1 trial あたりの平均シミュレーション時間は
  // 約 81 分→約 54 分 (v2 待ち手が joinedAt を並び直す staleTtlMs/2=15分・旧形式待ち手が諦める 15 分の
  // サイクルを 3 周以上する長さは維持。slots は trial ごとに 1〜2 の乱数、holders は平均 14 件・最大 39
  // 件 (旧: 平均 19 件・最大 52 件) で "long queue" の状況自体は変わらない)。trials は 100 のまま
  // (乱数パターンの多様性を落とさない)。単体実行で 5 回計測した結果 495〜912ms (旧: 2247〜3068ms、
  // 約 3〜4 倍の削減)。
  //
  // mutation 確認: planSlots の selfVisible ガードを `true` に固定すると steps=150/trials=100 はもちろん
  // steps=20/trials=5 まで削っても trial=0, step=14 で `startedAt.size` が `slots` を超えて確実に検出
  // された (この保証は step 数にほぼ依存しない)。ただし内訳を精査すると、この乱数列では待ち手の年齢が
  // 最大でも約 16 分にしか達しない (v2 の 15 分並び直し・旧形式の 15 分諦めがそれより先に効くため) ので、
  // step=14 の検出は selfVisible が兼ねる2つの役割のうち「先着の旧形式待ち手に阻まれている
  // (blockedByLegacy で eligible から外れ、selfIndex が -1 になる) 待ち手を弾く」側であり、「30 分を
  // 超えて stale になった待ち手を弾く」側 (文字通りの PR #749 のケース) はこのランダム化テストでは
  // 経路を通らない。年齢ベースの stale 境界は上の「does not let a waiter that others already treat as
  // stale take a slot until it re-joins (review of PR #749)」で決定的にカバーしている。この
  // ランダム化テストの主な役割は、多数 holder・長い待ち行列のもとで両方の弾き方を含む planSlots 全体の
  // 「running <= slots」不変条件を stress test することで、削減後もその力は落ちていない (上記の検出結果
  // に加え、barrier 除去・free-slot 計算の off-by-one・stale しきい値の縮小など複数系統の mutation でも
  // 150/100 steps で検出率に差が無いことを個別に確認済み)。
  //
  // 上記の削減後もなお高負荷時の余裕を持たせるため、既定 5000ms より大きい明示のタイムアウトも付与する
  // (単体実測の最大 912ms に対し 15000ms は 16 倍以上の余裕。旧設定の実測ワースト 5253ms に対しても
  // 約 3 倍の余裕)。
  it('keeps running <= slots with the real 30-minute stale rule, long queues and re-joining waiters', { timeout: 15_000 }, () => {
    // verify-slot.mjs の運用どおりに動かす: 新形式の待ち手は joinedAt から staleTtlMs / 2 で並び直し、
    // 旧スクリプトの待ち手は 15 分 (旧来の合計待ち上限) で諦める。verify は最長 10 分で終わる。
    let seed = 777;
    const random = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    const priorities = ['landed', 'merge', 'pr'];
    const staleTtlMs = OPTIONS.staleTtlMs;
    for (let trial = 0; trial < 100; trial += 1) {
      const slots = 1 + Math.floor(random() * 2);
      const holders = [];
      const startedAt = new Map();
      let now = T0;
      let nextPid = 1;
      const remove = (pid) => {
        startedAt.delete(pid);
        holders.splice(holders.findIndex((holder) => holder.pid === pid), 1);
      };
      for (let step = 0; step < 100; step += 1) {
        now += 5_000 + Math.floor(random() * 55_000);
        if (random() < 0.45) {
          const pid = nextPid++;
          const holder = random() < 0.4 ? legacy(pid, now) : v2(pid, now, priorities[Math.floor(random() * 3)], { queuedAt: now });
          if (holder.v === 2 && random() < 0.3) {
            holder.since = now - Math.floor(random() * 40 * MIN);
          }
          holders.push(holder);
        }
        for (const holder of [...holders]) {
          const ran = startedAt.get(holder.pid);
          if ((ran !== undefined && (now - ran > 10 * MIN || random() < 0.08)) || (ran === undefined && holder.v !== 2 && now - holder.joinedAt > 15 * MIN)) {
            remove(holder.pid);
          } else if (ran === undefined && holder.v === 2 && now - holder.joinedAt > staleTtlMs / 2) {
            holder.joinedAt = now; // 並び直し
          }
        }
        for (const holder of [...holders].sort(() => random() - 0.5)) {
          if (startedAt.has(holder.pid)) {
            continue;
          }
          const go = holder.v === 2 ? plan(holders, holder.pid, now, { slots }).acquire : legacyRank(holder, holders, now, staleTtlMs) < slots;
          if (go) {
            startedAt.set(holder.pid, now);
            if (holder.v === 2) {
              holder.acquiredAt = now;
            }
          }
        }
        expect(startedAt.size).toBeLessThanOrEqual(slots);
      }
    }
  });
});
