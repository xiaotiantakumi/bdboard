// bdboard-xdk8: landed (着地後検証) の verify は pr (PR 前の手元 verify) と同時に走らない — pr が走っていれば
// 始めず、landed が走っている間は pr を始めない。merge (着地予定ツリー) とは枠を分け合う。並び順 (仮想到着時刻) は
// 変えず、止まった先頭の後ろで飛ばしてよいのは規則に関わらない merge だけ (verify-slot-queue.mjs の EXCLUDED_BESIDE /
// pickStarters)。あわせて、この規則で止まっている待ちの打ち切りを相手が stale になるまで延ばすこと (明示した
// BDBOARD_VERIFY_SLOT_WAIT_MS は延ばさない)・走っている landed や予約を待つ側の表示 (kill を誘わない)・merge-pr の
// 再実行の隙間を埋める予約 holder (reserveVerifySlot / handoffPath) と、その席 (since を頭打ちにしない) も固定する。
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  acquireVerifySlot,
  DEFAULT_SLOT_OPTIONS,
  isHandoffPath,
  reserveVerifySlot,
  SlotWaitTimeoutError,
  slotWaitLimitMs,
  withoutSlotIdentity,
} from './verify-slot.mjs';
import { conflict, HOLDER_FORMAT, isNeutral, MAX_SENIORITY_MS, planSlots, TIER_STEP_MS } from './verify-slot-queue.mjs';

const NOW = 1_000_000_000;
const MIN = 60_000;
const OPTIONS = { slots: 2, now: NOW, staleTtlMs: 30 * MIN, tierStepMs: TIER_STEP_MS, maxSeniorityMs: MAX_SENIORITY_MS };

const holder = (pid, priority, queuedAgoMs, running = false, extra = {}) => ({
  v: HOLDER_FORMAT,
  pid,
  priority,
  joinedAt: NOW - queuedAgoMs,
  queuedAt: NOW - queuedAgoMs,
  ...(running ? { acquiredAt: NOW - queuedAgoMs } : {}),
  ...extra,
});

const plan = (holders, selfPid, options = {}) => planSlots(holders, { ...OPTIONS, ...options, selfPid });
const acquires = (holders, selfPid, options = {}) => plan(holders, selfPid, options).acquire;

describe('planSlots: landed does not run beside pr (bdboard-xdk8)', () => {
  it('the relation is symmetric and only pairs landed with pr; {} lets every pair share the slots', () => {
    const [landed, merge, pr] = ['landed', 'merge', 'pr'].map((priority) => ({ priority }));
    expect(conflict(landed, pr)).toBe(true);
    expect(conflict(pr, landed)).toBe(true);
    expect(conflict(landed, merge)).toBe(false);
    expect(conflict(landed, landed)).toBe(false);
    expect(conflict(merge, pr)).toBe(false);
    expect(conflict(landed, pr, {})).toBe(false);
    // 規則に関わらない (止まった先頭を飛ばしてよい) のは merge だけ。
    expect(['landed', 'merge', 'pr'].filter((priority) => isNeutral(priority))).toEqual(['merge']);
    expect(['landed', 'merge', 'pr'].filter((priority) => isNeutral(priority, {}))).toEqual(['landed', 'merge', 'pr']);
  });

  it('landed and merge share the slots in both directions', () => {
    expect(acquires([holder(1, 'landed', 5 * MIN, true), holder(2, 'merge', 1 * MIN)], 2)).toBe(true);
    expect(acquires([holder(1, 'merge', 5 * MIN, true), holder(2, 'landed', 1 * MIN)], 2)).toBe(true);
    // 同じ周に並んでいれば一緒に始める。
    const both = [holder(1, 'landed', 2 * MIN), holder(2, 'merge', 2 * MIN)];
    expect([acquires(both, 1), acquires(both, 2)]).toEqual([true, true]);
  });

  it('a pr waiter does not start while a landed verify runs, even with a free slot', () => {
    const holders = [holder(1, 'landed', 2 * MIN, true), holder(2, 'pr', 1 * MIN)];
    expect(acquires(holders, 2)).toBe(false);
    expect(acquires(holders, 2, { excludedBeside: {} })).toBe(true); // ulxa.6 までは空き枠で始めていた
    expect(plan(holders, 2).blocked).toMatchObject({ waiter: { pid: 2 }, other: { pid: 1, priority: 'landed' }, otherRunning: true });
  });

  it('a landed waiter does not start while a pr verify runs, even with a free slot, and starts once the pr leaves', () => {
    const busy = [holder(1, 'pr', 5 * MIN, true), holder(2, 'landed', 1 * MIN)];
    expect(acquires(busy, 2)).toBe(false);
    expect(plan(busy, 2).blocked).toMatchObject({ waiter: { pid: 2 }, other: { pid: 1, priority: 'pr' }, otherRunning: true });
    expect(acquires([holder(2, 'landed', 1 * MIN)], 2)).toBe(true);
  });

  it('a merge waiter takes a free slot past a blocked landed head; pr waiters behind the head never do', () => {
    const holders = [holder(1, 'pr', 9 * MIN, true), holder(2, 'landed', 3 * MIN), holder(3, 'merge', 2 * MIN), holder(4, 'pr', 1 * MIN)];
    expect(plan(holders, 3).queue.map((entry) => entry.pid)).toEqual([2, 3, 4]);
    expect([acquires(holders, 2), acquires(holders, 3), acquires(holders, 4)]).toEqual([false, true, false]);
    // 枠が余っていても、止まった先頭 (landed) の後ろの pr は飛ばさない (飛ばすと pr が続く限り landed が飢える)。
    expect(acquires(holders, 4, { slots: 3 })).toBe(false);
    // 後ろの pr にも、止まっている先頭とその相手が見える (表示と打ち切りの延長用)。merge は空き枠を待つだけなので null。
    expect(plan(holders, 4).blocked).toMatchObject({ waiter: { pid: 2 }, other: { pid: 1 }, otherRunning: true });
    expect(plan(holders, 3).blocked).toBeNull();
    // 飛ばさない比較用 (verify-slot-sim.mjs の prOnly): merge も先頭の後ろで止まる。
    expect(acquires(holders, 3, { skipPastBlocked: false })).toBe(false);
  });

  it('a merge waiter takes a free slot past a pr head blocked by a running landed; a landed waiter behind that head does not', () => {
    // [landed が走っている, pr が先頭で待つ, merge が待つ] で merge は始めてよい (landed と merge は同居してよい)。
    const simple = [holder(1, 'landed', 9 * MIN, true), holder(2, 'pr', 20 * MIN), holder(3, 'merge', 1 * MIN)];
    expect(plan(simple, 3).queue.map((entry) => entry.pid)).toEqual([2, 3]);
    expect([acquires(simple, 2), acquires(simple, 3)]).toEqual([false, true]);
    expect(acquires(simple, 3, { skipPastBlocked: false })).toBe(false);
    const holders = [holder(1, 'landed', 9 * MIN, true), holder(2, 'pr', 20 * MIN), holder(3, 'landed', 1 * MIN), holder(4, 'merge', 1 * MIN)];
    expect(plan(holders, 3).queue.map((entry) => entry.pid)).toEqual([2, 3, 4]); // pr が 8 分以上前に並んでいて先頭
    expect([acquires(holders, 2), acquires(holders, 3), acquires(holders, 4)]).toEqual([false, false, true]);
    expect(plan(holders, 3).blocked).toMatchObject({ waiter: { pid: 2 }, other: { pid: 1 } });
  });

  it('the blocked head takes the slot its blocker frees before the waiters that skipped it', () => {
    // pr (1) が走っている間に、止まった landed (2) を飛ばして merge (3) が走り出した。後ろにもう 1 本 merge (4)。
    const waiting = [holder(1, 'pr', 9 * MIN, true), holder(2, 'landed', 3 * MIN), holder(3, 'merge', 2 * MIN, true), holder(4, 'merge', 1 * MIN)];
    expect([acquires(waiting, 2), acquires(waiting, 4)]).toEqual([false, false]); // 空き枠なし
    // merge (3) が先に抜けても、pr (1) が走っている間は landed は始めず、merge (4) が空いた枠を使う。
    const mergeLeft = waiting.filter((entry) => entry.pid !== 3);
    expect([acquires(mergeLeft, 2), acquires(mergeLeft, 4)]).toEqual([false, true]);
    // pr (1) が抜けた周に空いた枠は、後ろの merge ではなく止まっていた先頭 (landed) が取る。
    const prLeft = waiting.filter((entry) => entry.pid !== 1);
    expect([acquires(prLeft, 2), acquires(prLeft, 4)]).toEqual([true, false]);
  });

  it('a pr waiter behind a landed waiter that starts this round waits for it (blocked by a starter, not a runner)', () => {
    const holders = [holder(1, 'landed', 2 * MIN), holder(2, 'pr', 1 * MIN)];
    expect([acquires(holders, 1), acquires(holders, 2)]).toEqual([true, false]);
    expect(plan(holders, 2).blocked).toMatchObject({ waiter: { pid: 2 }, other: { pid: 1 }, otherRunning: false });
  });

  it('keeps the virtual-arrival order: a pr waiter already ahead of the landed verify may still start first', () => {
    // pr が landed より 8 分 (段差 2 × 4 分) 以上前に並んでいれば、landed より前 (ulxa.6 の飢餓防止)。
    const holders = [holder(1, 'pr', 20 * MIN), holder(2, 'landed', 1 * MIN)];
    expect(acquires(holders, 1)).toBe(true);
    expect(acquires(holders, 2)).toBe(false); // 同じ周に始める pr とは同居しない
  });

  it('a landed verify that went stale (running > staleTtlMs) no longer blocks pr waiters', () => {
    const holders = [holder(1, 'landed', 31 * MIN, true), holder(2, 'pr', 1 * MIN)];
    expect(acquires(holders, 2)).toBe(true);
  });

  it('a reservation holder (merge-pr between the two landed runs) keeps later pr waiters out, but not merge', () => {
    // 1 回目の landed が抜けた直後: 走っている holder は無く、予約 (landed、since = 1 回目に並んだ時刻) が先頭。
    const reservation = holder(1, 'landed', 0, false, { since: NOW - 6 * MIN, reserved: true });
    const holders = [reservation, holder(2, 'pr', 5 * MIN), holder(3, 'merge', 5 * MIN)];
    expect(plan(holders, 2).queue.map((entry) => entry.pid)).toEqual([1, 3, 2]);
    expect(acquires(holders, 3)).toBe(true);
    expect(acquires(holders, 2)).toBe(false);
    expect(acquires(holders, 2, { excludedBeside: {} })).toBe(false); // 予約が無ければ取れていた枠は merge が使う
    expect(acquires(holders.filter((entry) => entry.pid !== 1), 2)).toBe(true);
  });

  it('the reservation and its retry keep the first queue time without the 10 min cap, so a pr that waited longer does not pass them', () => {
    // 1 回目の landed は 30 分前に並び、負荷で長く走った。pr は 20 分前から待っている (since の頭打ち 10 分より長い)。
    const pr = holder(2, 'pr', 20 * MIN);
    for (const extra of [{ reserved: true }, { retry: true }]) {
      const place = holder(1, 'landed', 0, false, { since: NOW - 30 * MIN, ...extra });
      expect(plan([place, pr], 2).queue.map((entry) => entry.pid)).toEqual([1, 2]);
      expect(acquires([place, pr], 2)).toBe(false); // 予約 (または再実行) が先に始める側で、pr はその隣で走らない
    }
    // 対照: ふつうの landed (と、landed 以外の予約) の since は 10 分で頭打ちなので、20 分待った pr が先。
    expect(plan([holder(1, 'landed', 0, false, { since: NOW - 30 * MIN }), pr], 2).queue.map((entry) => entry.pid)).toEqual([2, 1]);
    expect(plan([holder(1, 'merge', 0, false, { since: NOW - 30 * MIN, reserved: true }), pr], 2).queue.map((entry) => entry.pid)).toEqual([2, 1]);
  });
});

describe('slotWaitLimitMs: waits held up by the landed/pr rule outlast a long run (bdboard-xdk8)', () => {
  it('waits until the other run would go stale (staleTtlMs + 2 min) for landed and for any waiter held up by the rule', () => {
    expect(slotWaitLimitMs('landed', DEFAULT_SLOT_OPTIONS)).toBe(32 * MIN);
    expect(slotWaitLimitMs('merge', DEFAULT_SLOT_OPTIONS)).toBe(15 * MIN);
    expect(slotWaitLimitMs('pr', DEFAULT_SLOT_OPTIONS)).toBe(15 * MIN);
    expect(slotWaitLimitMs('landed', { ...DEFAULT_SLOT_OPTIONS, excludedBeside: {} })).toBe(15 * MIN);
    expect(slotWaitLimitMs('landed', { ...DEFAULT_SLOT_OPTIONS, waitTimeoutMs: 60 * MIN })).toBe(60 * MIN);
    // pr が走っている landed (または再実行の予約) の後ろで止まっている: 相手は正常に走っているので延ばす。
    const blockedPr = plan([holder(1, 'landed', 2 * MIN, true), holder(2, 'pr', 1 * MIN)], 2);
    expect(slotWaitLimitMs('pr', DEFAULT_SLOT_OPTIONS, blockedPr)).toBe(32 * MIN);
    const reservedAhead = plan([holder(1, 'landed', 0, false, { reserved: true, since: NOW - 5 * MIN }), holder(2, 'pr', 1 * MIN)], 2);
    expect(slotWaitLimitMs('pr', DEFAULT_SLOT_OPTIONS, reservedAhead)).toBe(32 * MIN);
    // 空き枠を待っているだけ (規則で止まっていない) なら延ばさない。
    const full = plan([holder(1, 'merge', 2 * MIN, true), holder(3, 'merge', 2 * MIN, true), holder(2, 'pr', 1 * MIN)], 2);
    expect(slotWaitLimitMs('pr', DEFAULT_SLOT_OPTIONS, full)).toBe(15 * MIN);
  });

  it('never extends an explicit BDBOARD_VERIFY_SLOT_WAIT_MS (tests and the emergency hatch)', () => {
    const explicit = { ...DEFAULT_SLOT_OPTIONS, waitTimeoutMs: 1_000, waitTimeoutFromEnv: true };
    expect(slotWaitLimitMs('landed', explicit)).toBe(1_000);
    expect(slotWaitLimitMs('pr', explicit, plan([holder(1, 'landed', 2 * MIN, true), holder(2, 'pr', 1 * MIN)], 2))).toBe(1_000);
  });
});

const makeDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'verify-slot-exclusive-'));
const holderFile = (dir, pid) => path.join(dir, `holder-${pid}.json`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const spawnLiveProcess = () => spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
const writeRunning = (dir, pid, priority, extra = {}) => {
  const now = Date.now();
  fs.writeFileSync(holderFile(dir, pid), JSON.stringify({ v: HOLDER_FORMAT, pid, priority, joinedAt: now, queuedAt: now, acquiredAt: now, ...extra }));
};
const fast = (dir, overrides) => ({ dir, slots: 2, staleTtlMs: 60_000, pollMs: 25, settleMs: 10, statusIntervalMs: 0, ...overrides });

const waitFor = async (predicate, what, { timeoutMs = 9_000, intervalMs = 10 } = {}) => {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
    }
    await sleep(intervalMs);
  }
};

describe('acquireVerifySlot: waiting beside a landed verify (bdboard-xdk8)', () => {
  it('a landed waiter is not cut off at waitTimeoutMs by a long pr run; it starts once that pr goes stale', async () => {
    const dir = makeDir();
    const other = spawnLiveProcess();
    try {
      writeRunning(dir, other.pid, 'pr');
      const lines = [];
      const started = Date.now();
      const slot = await acquireVerifySlot(fast(dir, { priority: 'landed', waitTimeoutMs: 200, staleTtlMs: 1_000 }), (line) => lines.push(line));
      slot.release();
      expect(Date.now() - started).toBeGreaterThanOrEqual(900); // waitTimeoutMs (200ms) では打ち切られていない
      expect(lines.join('\n')).toContain(`landed verify does not run beside pr verify pid ${other.pid}, waiting for it to finish`);
    } finally {
      other.kill('SIGKILL');
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a pr waiter blocked by a running landed verify is not cut off at waitTimeoutMs; it starts once that landed goes stale', async () => {
    const dir = makeDir();
    const other = spawnLiveProcess();
    try {
      writeRunning(dir, other.pid, 'landed');
      const started = Date.now();
      const slot = await acquireVerifySlot(fast(dir, { priority: 'pr', waitTimeoutMs: 200, staleTtlMs: 1_000 }), () => {});
      slot.release();
      expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    } finally {
      other.kill('SIGKILL');
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a pr waiter blocked by a running landed verify says it is normal and not to kill it, also when it times out', async () => {
    const dir = makeDir();
    const other = spawnLiveProcess();
    try {
      writeRunning(dir, other.pid, 'landed');
      const lines = [];
      // 打ち切りまで待たないよう、BDBOARD_VERIFY_SLOT_WAIT_MS で明示したときと同じ短い待ちにする。
      const pending = acquireVerifySlot(fast(dir, { priority: 'pr', waitTimeoutMs: 300, waitTimeoutFromEnv: true }), (line) => lines.push(line));
      const error = await pending.then(
        () => null,
        (caught) => caught,
      );
      expect(error).toBeInstanceOf(SlotWaitTimeoutError);
      expect(error.message).toContain(`A landed verify (pid ${other.pid}) is running: that is normal, do not kill it`);
      expect(error.message).not.toContain('hung verify');
      expect(lines.join('\n')).toContain(`landed verify pid ${other.pid} is running and pr verifies do not run beside it — normal, do not kill it`);
      expect(fs.existsSync(holderFile(dir, process.pid))).toBe(false);
    } finally {
      other.kill('SIGKILL');
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a pr waiter behind a retry reservation names the reservation (not an empty holder list and "hung verify?")', async () => {
    const dir = makeDir();
    const mergePr = spawnLiveProcess();
    try {
      const now = Date.now();
      const reservation = { v: HOLDER_FORMAT, pid: mergePr.pid, priority: 'landed', joinedAt: now, queuedAt: now, since: now - 60_000, reserved: true };
      fs.writeFileSync(holderFile(dir, mergePr.pid), JSON.stringify(reservation));
      const lines = [];
      const error = await acquireVerifySlot(fast(dir, { priority: 'pr', waitTimeoutMs: 300, waitTimeoutFromEnv: true }), (line) => lines.push(line)).then(
        () => null,
        (caught) => caught,
      );
      expect(error).toBeInstanceOf(SlotWaitTimeoutError);
      expect(error.message).toContain('holders: none running');
      expect(error.message).toContain(`the landed verify retry reserved by merge-pr pid ${mergePr.pid} is still queued: that is normal, do not kill merge-pr`);
      expect(error.message).not.toContain('hung verify');
      expect(lines.join('\n')).toContain(`pr verify waits for the landed verify retry reserved by merge-pr pid ${mergePr.pid}`);
    } finally {
      mergePr.kill('SIGKILL');
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

const modulePath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'verify-slot.mjs');
// 別プロセスで acquireVerifySlot に並び、取れたら優先度をログに書いて holdMs 後に返す。
const CHILD_SOURCE = `
  import fs from 'node:fs';
  const { acquireVerifySlot } = await import(process.env.VERIFY_SLOT_MODULE_URL);
  const since = process.env.QUEUE_SINCE ? Number(process.env.QUEUE_SINCE) : undefined;
  const slot = await acquireVerifySlot(
    { dir: process.env.VERIFY_SLOT_DIR, slots: 2, waitTimeoutMs: 15000, staleTtlMs: 60000, pollMs: 25, settleMs: 10,
      statusIntervalMs: 60000, priority: process.env.PRIORITY, queueSince: since, handoffPath: process.env.HANDOFF || undefined },
    () => {},
  );
  fs.appendFileSync(process.env.VERIFY_SLOT_LOG, process.env.PRIORITY + '\\n');
  await new Promise((resolve) => setTimeout(resolve, Number(process.env.HOLD_MS)));
  slot.release();
`;

describe('reserveVerifySlot: merge-pr holds the place of its landed retry (bdboard-xdk8)', () => {
  it('keeps a pr waiter out of the gap between the two runs; the retry removes the reservation once its own holder is written', { timeout: 20_000 }, async () => {
    const dir = makeDir();
    const logPath = path.join(dir, 'events.log');
    const readLog = () => (fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').trim().split('\n') : []);
    const children = [];
    const run = (priority, extraEnv) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', CHILD_SOURCE], {
        env: { ...withoutSlotIdentity(process.env), VERIFY_SLOT_MODULE_URL: pathToFileURL(modulePath).href, VERIFY_SLOT_DIR: dir, VERIFY_SLOT_LOG: logPath, PRIORITY: priority, ...extraEnv },
        stdio: 'ignore',
      });
      children.push(child);
      return { child, exited: new Promise((resolve) => child.on('exit', resolve)) };
    };
    const firstQueuedAt = Date.now() - 60_000;
    const reservation = await reserveVerifySlot({ dir, slots: 2, priority: 'landed', queueSince: firstQueuedAt });
    try {
      expect(reservation.path).toBe(holderFile(dir, process.pid));
      const reserved = JSON.parse(fs.readFileSync(reservation.path, 'utf8'));
      expect(reserved).toMatchObject({ v: HOLDER_FORMAT, pid: process.pid, priority: 'landed', since: firstQueuedAt, reserved: true });
      expect(reserved.acquiredAt).toBeUndefined(); // 並んでいるだけで、走ってはいない
      const pr = run('pr', { HOLD_MS: '50' });
      await waitFor(() => fs.existsSync(holderFile(dir, pr.child.pid)), 'the pr waiter to join the queue');
      await sleep(400); // pr の待ち手が何周も見ている間、予約しか無い (= 再実行の verify がまだ並んでいない隙間)
      expect(readLog()).toEqual([]);
      const retry = run('landed', { HOLD_MS: '300', QUEUE_SINCE: String(firstQueuedAt), HANDOFF: reservation.path });
      expect(await Promise.all([retry.exited, pr.exited])).toEqual([0, 0]);
      expect(readLog()).toEqual(['landed', 'pr']); // 隙間でも、再実行が走っている間も pr は始めていない
      expect(fs.existsSync(reservation.path)).toBe(false); // 再実行が自分の holder を書いた後で消した
    } finally {
      reservation.release(); // 冪等
      for (const child of children) {
        child.kill('SIGKILL');
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // bdboard-bwys: 上のテストが CI で 1 回 ['pr', 'landed'] になった競合を、io の差し替えで毎回起こす。再実行は「自分の holder を
  // 書いてから予約を消す」順だが、pr の待ち手の readdir がその間に挟まると、readdir には予約だけが載り、読みに行くと予約は
  // もう無い。その一覧だけで決めると landed が 1 本も見えず、修正前はそこで走り出していた (負荷をかけた再現で 700 回中
  // 24 回)。今は readOthers が一覧を読み直して再実行の holder を拾う (verify-slot-files.mjs)。
  it('a pr waiter that reads the reservation just as the retry takes it over does not start in that round; it reads again and waits behind the retry', async () => {
    const dir = makeDir();
    const mergePr = spawnLiveProcess();
    const retry = spawnLiveProcess();
    try {
      const now = Date.now();
      const since = now - 60_000;
      const reservationPath = holderFile(dir, mergePr.pid);
      fs.writeFileSync(reservationPath, JSON.stringify({ v: HOLDER_FORMAT, pid: mergePr.pid, priority: 'landed', joinedAt: now, queuedAt: now, since, reserved: true }));
      let handedOver = false;
      const io = {
        ...fs,
        readFileSync: (filePath, ...rest) => {
          if (!handedOver && path.resolve(filePath) === path.resolve(reservationPath)) {
            // 待ち手の readdir の後、予約を読む前に引き継ぎが起きる (再実行の holder を置いてから予約を消す。verify-slot.mjs と同じ順)。
            handedOver = true;
            const at = Date.now();
            fs.writeFileSync(holderFile(dir, retry.pid), JSON.stringify({ v: HOLDER_FORMAT, pid: retry.pid, priority: 'landed', joinedAt: at, queuedAt: at, since, retry: true }));
            fs.unlinkSync(reservationPath);
          }
          return fs.readFileSync(filePath, ...rest);
        },
      };
      const lines = [];
      const error = await acquireVerifySlot(fast(dir, { priority: 'pr', waitTimeoutMs: 300, waitTimeoutFromEnv: true, io }), (line) => lines.push(line)).then(
        (slot) => {
          slot.release();
          return null;
        },
        (caught) => caught,
      );
      expect(handedOver).toBe(true);
      expect(error).toBeInstanceOf(SlotWaitTimeoutError); // 修正前は予約が消えた周に走り出していた (error が null)
      expect(lines.join('\n')).toContain(`does not run beside landed verify pid ${retry.pid}`); // 読み直して再実行の後ろで待った
    } finally {
      mergePr.kill('SIGKILL');
      retry.kill('SIGKILL');
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // 上の読み直しが効くのは、再実行が「自分の holder を置いてから予約を消す」順を守るときだけ (逆順だと、予約が消えた後の
  // 一覧にも再実行の holder がまだ載っていないことがある)。その順を固定する (PR #877 のレビュー m1)。
  it('the retry renames its own holder in before it deletes the reservation it takes over', async () => {
    const dir = makeDir();
    const mergePr = spawnLiveProcess();
    try {
      const now = Date.now();
      const reservation = holderFile(dir, mergePr.pid);
      fs.writeFileSync(reservation, JSON.stringify({ v: HOLDER_FORMAT, pid: mergePr.pid, priority: 'landed', joinedAt: now, queuedAt: now, since: now - 60_000, reserved: true }));
      const own = holderFile(dir, process.pid);
      const events = [];
      const io = {
        ...fs,
        renameSync: (from, to) => {
          fs.renameSync(from, to);
          if (path.resolve(to) === path.resolve(own)) {
            events.push('own holder in');
          }
        },
        unlinkSync: (file) => {
          if (path.resolve(file) === path.resolve(reservation)) {
            events.push('reservation deleted');
          }
          return fs.unlinkSync(file);
        },
      };
      const slot = await acquireVerifySlot(fast(dir, { priority: 'landed', queueSince: now - 60_000, handoffPath: reservation, waitTimeoutMs: 2_000, io }), () => {});
      slot.release();
      expect(events.slice(0, 2)).toEqual(['own holder in', 'reservation deleted']);
      expect(fs.existsSync(reservation)).toBe(false);
    } finally {
      mergePr.kill('SIGKILL');
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a reservation left by a merge-pr that died is reaped like any dead holder', async () => {
    const dir = makeDir();
    try {
      const dead = spawnSync(process.execPath, ['-e', '']).pid;
      const now = Date.now();
      fs.writeFileSync(holderFile(dir, dead), JSON.stringify({ v: HOLDER_FORMAT, pid: dead, priority: 'landed', joinedAt: now, queuedAt: now, since: now - 60_000, reserved: true }));
      // 予約が残っていれば pr はその後ろで止まり、明示した短い待ち (waitTimeoutFromEnv) で打ち切られる。
      const slot = await acquireVerifySlot(fast(dir, { priority: 'pr', waitTimeoutMs: 2_000, waitTimeoutFromEnv: true }), () => {});
      slot.release();
      expect(fs.existsSync(holderFile(dir, dead))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('removes only a holder file in its own slot directory as the handoff, and writes nothing when gating is off', async () => {
    const dir = makeDir();
    const elsewhere = makeDir();
    try {
      const outside = path.join(elsewhere, 'holder-1.json');
      const notHolder = path.join(dir, 'notes.json');
      const inside = holderFile(dir, 1);
      for (const file of [outside, notHolder, inside]) {
        fs.writeFileSync(file, '{}');
      }
      for (const handoffPath of [outside, notHolder]) {
        (await acquireVerifySlot(fast(dir, { handoffPath, waitTimeoutMs: 2_000 }), () => {})).release();
        expect(fs.existsSync(handoffPath)).toBe(true);
      }
      fs.writeFileSync(inside, JSON.stringify({ v: HOLDER_FORMAT, pid: process.ppid, priority: 'landed', joinedAt: Date.now(), queuedAt: Date.now() }));
      (await acquireVerifySlot(fast(dir, { handoffPath: inside, priority: 'merge', waitTimeoutMs: 2_000 }), () => {})).release();
      expect(fs.existsSync(inside)).toBe(false);
      expect((await reserveVerifySlot({ dir, slots: 0 })).path).toBeUndefined();
      expect(fs.existsSync(holderFile(dir, process.pid))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it('isHandoffPath refuses the verify\'s own holder path, also when it is written another way', async () => {
    const dir = makeDir();
    try {
      const self = holderFile(dir, process.pid);
      for (const own of [self, `${dir}${path.sep}.${path.sep}holder-${process.pid}.json`, path.join(dir, 'sub', '..', `holder-${process.pid}.json`)]) {
        expect(isHandoffPath(own, dir, self)).toBe(false);
      }
      expect(isHandoffPath(holderFile(dir, 7), `${dir}${path.sep}`, self)).toBe(true);
      expect(isHandoffPath(`${holderFile(dir, 7)}.tmp`, dir, self)).toBe(false);
      expect(isHandoffPath(undefined, dir, self)).toBe(false);
      // 自分の holder を予約として渡されても消さない (消すと他の待ち手から見えなくなり、上限を超えうる)。
      const slot = await acquireVerifySlot(fast(dir, { priority: 'landed', handoffPath: `${dir}${path.sep}.${path.sep}holder-${process.pid}.json`, waitTimeoutMs: 2_000 }), () => {});
      try {
        expect(JSON.parse(fs.readFileSync(self, 'utf8'))).toMatchObject({ pid: process.pid, acquiredAt: expect.any(Number) });
        expect(JSON.parse(fs.readFileSync(self, 'utf8')).retry).toBeUndefined();
      } finally {
        slot.release();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // 予約を置いた merge-pr の代わりに生きている pid を使い、予約の holder file を書く。
  const writeReservation = (dir, pid, since) => {
    const now = Date.now();
    fs.writeFileSync(holderFile(dir, pid), JSON.stringify({ v: HOLDER_FORMAT, pid, priority: 'landed', joinedAt: now, queuedAt: now, since, reserved: true }));
    return holderFile(dir, pid);
  };

  it('the retry removes the reservation before its first settle, while both slots are busy, and starts once one frees', async () => {
    const dir = makeDir();
    const [mergeA, mergeB, mergePr] = [spawnLiveProcess(), spawnLiveProcess(), spawnLiveProcess()];
    try {
      writeRunning(dir, mergeA.pid, 'merge');
      writeRunning(dir, mergeB.pid, 'merge');
      const since = Date.now() - 60_000;
      const reservation = writeReservation(dir, mergePr.pid, since);
      const lines = [];
      const options = { priority: 'landed', queueSince: since, handoffPath: reservation, settleMs: 1_500, waitTimeoutMs: 8_000, waitTimeoutFromEnv: true };
      const pending = acquireVerifySlot(fast(dir, options), (line) => lines.push(line));
      await waitFor(() => fs.existsSync(holderFile(dir, process.pid)), 'the retry to write its own holder');
      await waitFor(() => !fs.existsSync(reservation), 'the retry to remove the reservation', { timeoutMs: 500 });
      expect(lines).toEqual([]); // まだ最初の settle の中 (並び順を 1 度も読んでいない)
      expect(JSON.parse(fs.readFileSync(holderFile(dir, process.pid), 'utf8'))).toMatchObject({ priority: 'landed', since, retry: true });
      await waitFor(() => lines.length > 0, 'the first status line');
      expect(lines[0]).toContain('queue position 1/1');
      fs.rmSync(holderFile(dir, mergeB.pid));
      (await pending).release();
    } finally {
      for (const child of [mergeA, mergeB, mergePr]) {
        child.kill('SIGKILL');
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the retry starts beside a running merge right away instead of queueing behind its own reservation', async () => {
    const dir = makeDir();
    const [merge, mergePr] = [spawnLiveProcess(), spawnLiveProcess()];
    try {
      writeRunning(dir, merge.pid, 'merge');
      const since = Date.now() - 60_000;
      const reservation = writeReservation(dir, mergePr.pid, since);
      const lines = [];
      const slot = await acquireVerifySlot(
        fast(dir, { priority: 'landed', queueSince: since, handoffPath: reservation, waitTimeoutMs: 2_000, waitTimeoutFromEnv: true }),
        (line) => lines.push(line),
      );
      slot.release();
      expect(lines).toEqual([]); // 1 周目で取った (予約の後ろで待っていない)
      expect(fs.existsSync(reservation)).toBe(false);
    } finally {
      merge.kill('SIGKILL');
      mergePr.kill('SIGKILL');
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('says so when it cannot remove the reservation, and the retry still goes on without waiting behind it', async () => {
    const dir = makeDir();
    const [merge, mergePr] = [spawnLiveProcess(), spawnLiveProcess()];
    try {
      writeRunning(dir, merge.pid, 'merge');
      const since = Date.now() - 60_000;
      const reservation = writeReservation(dir, mergePr.pid, since);
      const io = {
        ...fs,
        unlinkSync: (file) => {
          if (path.resolve(file) === path.resolve(reservation)) {
            throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
          }
          return fs.unlinkSync(file);
        },
      };
      const lines = [];
      const slot = await acquireVerifySlot(
        fast(dir, { priority: 'landed', queueSince: since, handoffPath: reservation, io, waitTimeoutMs: 2_000, waitTimeoutFromEnv: true }),
        (line) => lines.push(line),
      );
      slot.release();
      expect(lines.join('\n')).toContain(`verify: warning: could not remove the landed retry reservation ${reservation} (EPERM)`);
      expect(fs.existsSync(reservation)).toBe(true); // 残った予約は merge-pr が再実行の後で消す
    } finally {
      merge.kill('SIGKILL');
      mergePr.kill('SIGKILL');
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the reservation is removed by the process exit hook when merge-pr exits without releasing it', () => {
    const dir = makeDir();
    try {
      const out = path.join(dir, 'reserved.txt');
      const source = `
        import fs from 'node:fs';
        const { reserveVerifySlot } = await import(process.env.VERIFY_SLOT_MODULE_URL);
        const reservation = await reserveVerifySlot({ dir: process.env.VERIFY_SLOT_DIR, slots: 2, priority: 'landed', queueSince: Date.now() });
        fs.writeFileSync(process.env.OUT, String(fs.existsSync(reservation.path)));
        process.exit(0); // release() を呼ばずに抜ける (中断で process.exit する経路)
      `;
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
        env: { ...withoutSlotIdentity(process.env), VERIFY_SLOT_MODULE_URL: pathToFileURL(modulePath).href, VERIFY_SLOT_DIR: dir, OUT: out },
        encoding: 'utf8',
      });
      expect(result.status, result.stderr).toBe(0);
      expect(fs.readFileSync(out, 'utf8')).toBe('true');
      expect(fs.readdirSync(dir).filter((name) => name.startsWith('holder-'))).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
