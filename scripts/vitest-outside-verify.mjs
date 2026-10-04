// bdboard-72oy: verify の外で走る単発の vitest が、着地後検証 (landed) の走行中なら警告して監査ログに残す。
// vitest の globalSetup (scripts/vitest-global-setup.mjs) から呼ばれる。待たせはしない (まず頻度を測る)。
// holder file の読み取りと「走っている」の判定は verify スロット本体と同じ readOthers / planSlots を使う。
//
// 警告するのは landed が走っている (running) ときだけ。順番待ち (waiting) と merge-pr の再実行の予約 (reserved) の
// landed が居るときは、警告せずに監査ログにだけ残す: 負荷はまだ無いが、すぐ始まる verify と単発の vitest が重なった
// 頻度を測るため (走り出した直後に始めた単発は running の記録だけでは数え漏れる)。stale と死んだ pid は数えない。
import { DEFAULT_SLOT_OPTIONS, envSlotOptions, IN_VERIFY_ENV } from './verify-slot.mjs';
import { holderPath, readOthers } from './verify-slot-files.mjs';
import { normalizePriority, planSlots } from './verify-slot-queue.mjs';

export const OUTSIDE_VERIFY_AUDIT_EVENT = 'vitest-outside-verify';
/** landed holder の状態。複数居るときは先頭の状態を記録する (走っているものが一番重い)。 */
export const LANDED_STATES = Object.freeze(['running', 'waiting', 'reserved']);

export function isInsideVerify(env = process.env) {
  return env[IN_VERIFY_ENV] === '1';
}

/**
 * スロットの置き場にいる landed の holder を状態ごとに返す: running (枠を取って走っている)・waiting (順番待ち)・
 * reserved (merge-pr の再実行の予約)。読めない・無い・スロット無効のときは全部空 (fail open)。
 */
export function landedHolders(env = process.env, { now = Date.now(), selfPid = process.pid, io } = {}) {
  const none = { running: [], waiting: [], reserved: [] };
  try {
    const options = { ...DEFAULT_SLOT_OPTIONS, ...envSlotOptions(env) };
    if (options.slots <= 0) {
      return none;
    }
    // readOthers と同じく、死んだ pid の holder などは読み取り時に回収される。
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
    const isLanded = (holder) => normalizePriority(holder.priority) === 'landed';
    const queued = plan.queue.filter(isLanded);
    return {
      running: plan.running.filter(isLanded),
      waiting: queued.filter((holder) => holder.reserved !== true),
      reserved: queued.filter((holder) => holder.reserved === true),
    };
  } catch {
    return none;
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

function auditFields(holders, state, now, context) {
  const first = holders[0];
  const running = state === 'running';
  const since = running ? first.acquiredAt : (first.queuedAt ?? first.joinedAt);
  return {
    pid: process.pid,
    cwd: process.cwd(),
    project: context.root,
    cmd: process.argv.slice(1).join(' ').slice(0, 200),
    landed_state: state,
    landed_pid: first.pid,
    landed_count: holders.length,
    [running ? 'landed_running_s' : 'landed_waited_s']: Math.max(0, Math.floor((now - since) / 1000)),
  };
}

async function recordAudit(fields) {
  const { audit } = await import('./merge-pr/state.mjs');
  audit(OUTSIDE_VERIFY_AUDIT_EVENT, fields);
}

// 何があっても投げない (警告も記録も診断であって、vitest の実行を止める理由にならない)。
// state = 記録した landed の状態 (無ければ null)、warned = 警告を出したか (running のときだけ)。
export async function checkOutsideVerify({ env = process.env, now = Date.now(), selfPid = process.pid, io, warn, record, context = {} } = {}) {
  try {
    if (isInsideVerify(env)) {
      return { inside: true, landed: [], state: null, warned: false };
    }
    const found = landedHolders(env, { now, selfPid, io });
    const state = LANDED_STATES.find((name) => found[name].length > 0);
    if (state === undefined) {
      return { inside: false, landed: [], state: null, warned: false };
    }
    const landed = found[state];
    const fields = auditFields(landed, state, now, context);
    const warned = state === 'running';
    if (warned) {
      try {
        (warn || ((line) => process.stderr.write(`${line}\n`)))(warningMessage(landed, now));
      } catch {
        // 警告出力の失敗で vitest を止めない。
      }
    }
    try {
      await (record || recordAudit)(fields);
    } catch {
      // 監査ログの失敗で vitest を止めない。
    }
    return { inside: false, landed, state, warned };
  } catch {
    return { inside: false, landed: [], state: null, warned: false };
  }
}
