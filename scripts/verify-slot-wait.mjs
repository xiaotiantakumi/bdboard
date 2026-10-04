// bdboard-xdk8: verify スロットの待ちの打ち切りと待ちの表示のうち、同居させない組 (verify-slot-queue.mjs の
// EXCLUDED_BESIDE、landed と pr) と merge-pr の再実行の予約 (reserved) に関わる部分。verify-slot.mjs を
// max-lines 200 に収めるために切り出した。
// verify.mjs の import graph に入るので、古い Node でもパースできる構文に保つこと (bdboard-eu2k)。
import { excludesOthers } from './verify-slot-queue.mjs';

// bdboard-xdk8: 同居の規則で止まっている待ちの打ち切りを、相手が stale (staleTtlMs) になって数から外れるまで
// 延ばすときの余裕。負荷で 15 分を超えて走る正常な verify を待っている間に打ち切られないため。
const EXCLUDING_WAIT_MARGIN_MS = 2 * 60_000;

/**
 * 待ちの打ち切り (ms、bdboard-xdk8)。既定は waitTimeoutMs。次の待ち手は、相手が stale になって数から外れるまで
 * (staleTtlMs + 余裕) 打ち切らない: 他を止める側 (landed。走っている pr が抜けるのを待つ) と、空き枠があるのに
 * この規則で止められている待ち手 (plan.blocked。走っている landed や再実行の予約の後ろで待つ pr 等 — 相手は正常に
 * 走っている)。空き枠が無くて待っているだけの待ち手 (landed + merge が 2 枠を埋めている間の pr 等) は pickStarters が
 * blocked を立てないので延ばさず、waitTimeoutMs のまま (bdboard-e8jj。docs/VERIFY.md「Wait limits under this rule」)。
 * BDBOARD_VERIFY_SLOT_WAIT_MS で明示した値 (options.waitTimeoutFromEnv) は延ばさずにそのまま使う (テストと
 * 緊急脱出ハッチ。landed の verify の中で走るテストが、受け継いだ優先度で 32 分待ってしまわないため)。
 */
export function slotWaitLimitMs(priority, options, plan = null) {
  if (options.waitTimeoutFromEnv === true) {
    return options.waitTimeoutMs;
  }
  if (!excludesOthers(priority, options.excludedBeside) && (plan === null || plan.blocked === null)) {
    return options.waitTimeoutMs;
  }
  return Math.max(options.waitTimeoutMs, options.staleTtlMs + EXCLUDING_WAIT_MARGIN_MS);
}

const describeOther = (other) =>
  other.reserved === true ? `the ${other.priority} verify retry reserved by merge-pr pid ${other.pid}` : `${other.priority} verify pid ${other.pid}`;

// 待ちの表示に足す、同居させない組 (bdboard-xdk8) の説明。
function blockedNote(plan, holder, options) {
  const { blocked } = plan;
  if (blocked === null) {
    return '';
  }
  const { waiter, other, otherRunning } = blocked;
  if (other.reserved === true) {
    return `; ${waiter.pid === holder.pid ? `${waiter.priority} verify` : `behind ${waiter.priority} verify pid ${waiter.pid}, which`} waits for ${describeOther(other)} (merge-pr is re-running a landed verify) — normal, do not kill it`;
  }
  if (otherRunning && excludesOthers(other.priority, options.excludedBeside)) {
    return `; ${describeOther(other)} is running and ${waiter.priority} verifies do not run beside it — normal, do not kill it`;
  }
  const how = otherRunning ? 'to finish' : 'which starts first';
  if (waiter.pid === holder.pid) {
    return `; ${waiter.priority} verify does not run beside ${describeOther(other)}, waiting for it ${how}`;
  }
  return `; behind ${waiter.priority} verify pid ${waiter.pid}, which does not run beside ${describeOther(other)}`;
}

const holdersText = (plan) => (plan.running.length === 0 ? 'none running' : `pid ${plan.running.map((entry) => entry.pid).join(', ')}`);

/** 待っている間に statusIntervalMs ごとに出す 1 行。 */
export function waitStatusLine(plan, holder, options, now) {
  return (
    `verify: waiting for a verify slot (queue position ${plan.position}/${plan.queue.length}, priority ${holder.priority},` +
    ` holders: ${holdersText(plan)}, waited ${Math.round((now - holder.queuedAt) / 1000)}s${blockedNote(plan, holder, options)}) — queueing, not a hang`
  );
}

function timeoutAdvice(plan, options) {
  const reservation = plan.blocked !== null && plan.blocked.other.reserved === true ? plan.blocked.other : null;
  if (reservation !== null) {
    return ` ${describeOther(reservation)} is still queued: that is normal, do not kill merge-pr — retry after its landed verify finishes; do not disable the slot to get past this.`;
  }
  const excluders = plan.running.filter((entry) => excludesOthers(entry.priority, options.excludedBeside));
  if (excluders.length > 0) {
    const pids = excluders.map((entry) => entry.pid).join(', ');
    return ` A ${excluders[0].priority} verify (pid ${pids}) is running: that is normal, do not kill it — retry after it finishes; do not disable the slot to get past this.`;
  }
  return ' Investigate those pids (hung verify?) before retrying; do not disable the slot to get past this.';
}

/** 待ちの打ち切り (SlotWaitTimeoutError) のメッセージ。 */
export function timeoutMessage(plan, options, waitedMs) {
  return (
    `verify: timed out after ${Math.round(waitedMs / 1000)}s without progress waiting for a verify slot` +
    ` (slots=${options.slots}, holders: ${holdersText(plan)}).${timeoutAdvice(plan, options)}`
  );
}
