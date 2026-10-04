// bdboard-xdk8: landed (着地後検証) の verify は pr (PR 前の手元 verify) と同時に走らない — pr が走っていれば
// 始めず、landed が走っている間は pr を始めない。merge (着地予定ツリー) とは枠を分け合う。並び順 (仮想到着時刻) は
// 変えず、止まった待ち手の後ろは飛ばさない (verify-slot-queue.mjs の EXCLUDED_BESIDE / pickStarters)。
// あわせて、landed の待ちの打ち切りを pr が stale になるまで延ばすこと・走っている landed を待つ側の表示
// (kill を誘わない)・merge-pr の再実行の隙間を埋める予約 holder (reserveVerifySlot / handoffPath) も固定する。
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

import { acquireVerifySlot, DEFAULT_SLOT_OPTIONS, reserveVerifySlot, SlotWaitTimeoutError, slotWaitLimitMs } from './verify-slot.mjs';
import { conflict, HOLDER_FORMAT, MAX_SENIORITY_MS, planSlots, TIER_STEP_MS } from './verify-slot-queue.mjs';

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

  it('nobody behind a blocked landed waiter starts, merge included (the order is never skipped)', () => {
    const holders = [holder(1, 'pr', 9 * MIN, true), holder(2, 'landed', 3 * MIN), holder(3, 'merge', 2 * MIN), holder(4, 'pr', 1 * MIN)];
    expect(plan(holders, 3).queue.map((entry) => entry.pid)).toEqual([2, 3, 4]);
    expect([acquires(holders, 2), acquires(holders, 3), acquires(holders, 4)]).toEqual([false, false, false]);
    // 後ろの待ち手にも、止まっている先頭とその相手が見える (表示用)。
    expect(plan(holders, 4).blocked).toMatchObject({ waiter: { pid: 2 }, other: { pid: 1 }, otherRunning: true });
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
});

describe('slotWaitLimitMs: the landed waiter outlasts a pr verify that runs long (bdboard-xdk8)', () => {
  it('waits until a running pr would go stale (staleTtlMs + 2 min) for landed, and waitTimeoutMs for the others', () => {
    expect(slotWaitLimitMs('landed', DEFAULT_SLOT_OPTIONS)).toBe(32 * MIN);
    expect(slotWaitLimitMs('merge', DEFAULT_SLOT_OPTIONS)).toBe(15 * MIN);
    expect(slotWaitLimitMs('pr', DEFAULT_SLOT_OPTIONS)).toBe(15 * MIN);
    expect(slotWaitLimitMs('landed', { ...DEFAULT_SLOT_OPTIONS, excludedBeside: {} })).toBe(15 * MIN);
    expect(slotWaitLimitMs('landed', { ...DEFAULT_SLOT_OPTIONS, waitTimeoutMs: 60 * MIN })).toBe(60 * MIN);
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

  it('a pr waiter blocked by a running landed verify says it is normal and not to kill it, also when it times out', async () => {
    const dir = makeDir();
    const other = spawnLiveProcess();
    try {
      writeRunning(dir, other.pid, 'landed');
      const lines = [];
      const pending = acquireVerifySlot(fast(dir, { priority: 'pr', waitTimeoutMs: 300 }), (line) => lines.push(line));
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
        env: { ...process.env, VERIFY_SLOT_MODULE_URL: pathToFileURL(modulePath).href, VERIFY_SLOT_DIR: dir, VERIFY_SLOT_LOG: logPath, PRIORITY: priority, ...extraEnv },
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

  it('a reservation left by a merge-pr that died is reaped like any dead holder', async () => {
    const dir = makeDir();
    try {
      const dead = spawnSync(process.execPath, ['-e', '']).pid;
      const now = Date.now();
      fs.writeFileSync(holderFile(dir, dead), JSON.stringify({ v: HOLDER_FORMAT, pid: dead, priority: 'landed', joinedAt: now, queuedAt: now, since: now - 60_000, reserved: true }));
      // 予約が残っていれば pr はその後ろで止まり、waitTimeoutMs で打ち切られる。
      const slot = await acquireVerifySlot(fast(dir, { priority: 'pr', waitTimeoutMs: 2_000 }), () => {});
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
});
