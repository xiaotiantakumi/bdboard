// bdboard-72oy: verify の外で走る単発の vitest が、着地後検証 (landed) の走行中なら警告して監査ログに残す。
// vitest の globalSetup (scripts/vitest-global-setup.mjs) から呼ばれる。待たせはしない (まず頻度を測る)。
// holder file の読み取りと「走っている」の判定は verify スロット本体と同じ readOthers / planSlots を使う。
import { DEFAULT_SLOT_OPTIONS, envSlotOptions, IN_VERIFY_ENV } from './verify-slot.mjs';
import { holderPath, readOthers } from './verify-slot-files.mjs';
import { normalizePriority, planSlots } from './verify-slot-queue.mjs';

export const OUTSIDE_VERIFY_AUDIT_EVENT = 'vitest-outside-verify';

export function isInsideVerify(env = process.env) {
  return env[IN_VERIFY_ENV] === '1';
}

export function runningLandedHolders(env = process.env, { now = Date.now(), selfPid = process.pid, io } = {}) {
  const options = { ...DEFAULT_SLOT_OPTIONS, ...envSlotOptions(env) };
  if (options.slots <= 0) {
    return [];
  }
  try {
    // readOthers と同じく、死んだ pid の holder は読み取り時に回収される。
    const { others } = readOthers(options.dir, holderPath(options.dir, selfPid), { io, now });
    const plan = planSlots(others, {
      selfPid,
      slots: options.slots,
      now,
      staleTtlMs: options.staleTtlMs,
      tierStepMs: options.tierStepMs,
      maxSeniorityMs: options.maxSeniorityMs,
      excludedBeside: options.excludedBeside,
    });
    return plan.running.filter((holder) => normalizePriority(holder.priority) === 'landed');
  } catch {
    return [];
  }
}

function warningMessage(holders, now) {
  const listed = holders.slice(0, 3).map((holder) => `pid ${holder.pid}, running ${formatDuration(now - holder.acquiredAt)}`);
  if (holders.length > 3) {
    listed.push(`and ${holders.length - 3} more`);
  }
  return `vitest: warning: a landed verify (${listed.join('; ')}) is in progress and this vitest run is outside npm run verify, so the verify slots do not count it; the load can make the landed verify fail with a false timeout (bdboard-xdk8); consider waiting for it to finish — this run is NOT delayed.`;
}

function formatDuration(milliseconds) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function auditFields(holders, now, context) {
  const first = holders[0];
  return {
    pid: process.pid,
    cwd: process.cwd(),
    project: context.root,
    cmd: process.argv.slice(1).join(' ').slice(0, 200),
    landed_pid: first.pid,
    landed_count: holders.length,
    landed_running_s: Math.max(0, Math.floor((now - first.acquiredAt) / 1000)),
  };
}

async function recordAudit(fields) {
  const { audit } = await import('./merge-pr/state.mjs');
  audit(OUTSIDE_VERIFY_AUDIT_EVENT, fields);
}

// 何があっても投げない (警告も記録も診断であって、vitest の実行を止める理由にならない)。
export async function checkOutsideVerify({ env = process.env, now = Date.now(), selfPid = process.pid, io, warn, record, context = {} } = {}) {
  try {
    if (isInsideVerify(env)) {
      return { inside: true, landed: [], warned: false };
    }
    const landed = runningLandedHolders(env, { now, selfPid, io });
    if (landed.length === 0) {
      return { inside: false, landed: [], warned: false };
    }
    const message = warningMessage(landed, now);
    const fields = auditFields(landed, now, context);
    try {
      (warn || ((line) => process.stderr.write(`${line}\n`)))(message);
    } catch {
      // 警告出力の失敗で vitest を止めない。
    }
    try {
      await (record || recordAudit)(fields);
    } catch {
      // 監査ログの失敗で vitest を止めない。
    }
    return { inside: false, landed, warned: true };
  } catch {
    return { inside: false, landed: [], warned: false };
  }
}
