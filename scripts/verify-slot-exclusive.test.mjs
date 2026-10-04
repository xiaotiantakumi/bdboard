// bdboard-xdk8: landed (着地後検証) の verify は独占して走る — 走っている holder が抜けるまで始めず、
// 走っている間・順番を待っている間は後ろの待ち手を始めない。並び順 (仮想到着時刻) は変えない。
// 独占の待ちにも既存のスロット待ちの打ち切り (SlotWaitTimeoutError → verify.mjs の exit 75、bdboard-wj9m) が効く。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { acquireVerifySlot, SlotWaitTimeoutError } from './verify-slot.mjs';
import { HOLDER_FORMAT, MAX_SENIORITY_MS, planSlots, TIER_STEP_MS } from './verify-slot-queue.mjs';

const NOW = 1_000_000_000;
const MIN = 60_000;
const OPTIONS = { slots: 2, now: NOW, staleTtlMs: 30 * MIN, tierStepMs: TIER_STEP_MS, maxSeniorityMs: MAX_SENIORITY_MS };

const holder = (pid, priority, queuedAgoMs, running = false) => ({
  v: HOLDER_FORMAT,
  pid,
  priority,
  joinedAt: NOW - queuedAgoMs,
  queuedAt: NOW - queuedAgoMs,
  ...(running ? { acquiredAt: NOW - queuedAgoMs } : {}),
});

const acquires = (holders, selfPid, options = {}) => planSlots(holders, { ...OPTIONS, ...options, selfPid }).acquire;

describe('planSlots: landed runs alone (bdboard-xdk8)', () => {
  it('a landed waiter does not start beside a running holder even with a free slot, and starts once it is alone', () => {
    const busy = [holder(1, 'pr', 5 * MIN, true), holder(2, 'landed', 1 * MIN)];
    expect(acquires(busy, 2)).toBe(false);
    expect(acquires(busy, 2, { exclusivePriorities: [] })).toBe(true); // 独占でなければ空き枠で始める (ulxa.6 まで)
    expect(acquires([holder(2, 'landed', 1 * MIN)], 2)).toBe(true);
  });

  it('nobody starts while a landed verify runs, and waiters behind a queued landed verify wait for it', () => {
    const landedRunning = [holder(1, 'landed', 2 * MIN, true), holder(2, 'merge', 1 * MIN), holder(3, 'pr', 1 * MIN)];
    expect(acquires(landedRunning, 2)).toBe(false);
    expect(acquires(landedRunning, 3)).toBe(false);
    const plan = planSlots(landedRunning, { ...OPTIONS, selfPid: 3 });
    expect(plan.exclusivePid).toBe(1);
    // landed が順番待ち (走っている 1 本が抜けるのを待っている) の間、後から来た pr は空き枠があっても始めない。
    const landedQueued = [holder(1, 'pr', 9 * MIN, true), holder(2, 'landed', 2 * MIN), holder(3, 'pr', 1 * MIN)];
    expect(acquires(landedQueued, 3)).toBe(false);
    expect(planSlots(landedQueued, { ...OPTIONS, selfPid: 3 }).exclusivePid).toBe(2);
  });

  it('keeps the virtual-arrival order: a waiter already ahead of the landed verify may still start first', () => {
    // pr が landed より 8 分 (段差 2 × 4 分) 以上前に並んでいれば、landed より前 (ulxa.6 の飢餓防止)。
    const holders = [holder(1, 'pr', 20 * MIN), holder(2, 'landed', 1 * MIN)];
    expect(acquires(holders, 1)).toBe(true);
    expect(acquires(holders, 2)).toBe(false); // 先に始める待ち手がいる周は、landed は始めない
  });

  it('two landed verifies run one at a time', () => {
    const holders = [holder(1, 'landed', 3 * MIN), holder(2, 'landed', 1 * MIN)];
    expect(acquires(holders, 1)).toBe(true);
    expect(acquires(holders, 2)).toBe(false);
  });

  it('a landed verify that went stale (running > staleTtlMs) no longer blocks the others', () => {
    const holders = [holder(1, 'landed', 31 * MIN, true), holder(2, 'pr', 1 * MIN)];
    expect(acquires(holders, 2)).toBe(true);
  });
});

describe('acquireVerifySlot: the exclusive wait times out like any other slot wait (bdboard-wj9m)', () => {
  it('a landed verify waiting for a running holder that never leaves gets SlotWaitTimeoutError', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-slot-exclusive-'));
    const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
    try {
      // 2 枠のうち 1 本しか走っていない (枠は空いている) が、landed は独占なので待ち、打ち切られる。
      const running = { v: HOLDER_FORMAT, pid: other.pid, priority: 'pr', joinedAt: Date.now(), queuedAt: Date.now(), acquiredAt: Date.now() };
      fs.writeFileSync(path.join(dir, `holder-${other.pid}.json`), JSON.stringify(running));
      const lines = [];
      const options = { dir, slots: 2, priority: 'landed', waitTimeoutMs: 300, staleTtlMs: 60_000, pollMs: 25, settleMs: 10, statusIntervalMs: 0 };
      await expect(acquireVerifySlot(options, (line) => lines.push(line))).rejects.toBeInstanceOf(SlotWaitTimeoutError);
      expect(lines.join('\n')).toContain('landed verify runs alone, waiting for the running holders to finish');
      expect(fs.existsSync(path.join(dir, `holder-${process.pid}.json`))).toBe(false);
    } finally {
      other.kill('SIGKILL');
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
