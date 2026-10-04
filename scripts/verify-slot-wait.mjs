// bdboard-xdk8: verify スロットの待ちの打ち切りと待ちの表示のうち、同居させない組 (verify-slot-queue.mjs の
// EXCLUDED_BESIDE、landed と pr) に関わる部分。verify-slot.mjs を max-lines 200 に収めるために切り出した。
// verify.mjs の import graph に入るので、古い Node でもパースできる構文に保つこと (bdboard-eu2k)。
import { excludesOthers } from './verify-slot-queue.mjs';

// bdboard-xdk8: 他を止める側 (landed) の待ちの打ち切りを、走っている相手が stale (staleTtlMs) になって
// 数から外れるまで延ばすときの余裕。負荷で 15 分を超えて走る pr verify を待っている間に打ち切られないため。
const EXCLUDING_WAIT_MARGIN_MS = 2 * 60_000;

/**
 * 待ちの打ち切り (ms、bdboard-xdk8)。他を止める側 (landed) は走っている pr が抜けるのを待つので、その pr が
 * stale になって数から外れるまで (staleTtlMs + 余裕) は打ち切らない。それ以外は waitTimeoutMs のまま。
 */
export function slotWaitLimitMs(priority, options) {
  if (!excludesOthers(priority, options.excludedBeside)) {
    return options.waitTimeoutMs;
  }
  return Math.max(options.waitTimeoutMs, options.staleTtlMs + EXCLUDING_WAIT_MARGIN_MS);
}

// 走っている landed (他を止める側) の holder。これを待っているのは正常 (kill しない)。
const runningExcluders = (plan, options) => plan.running.filter((entry) => excludesOthers(entry.priority, options.excludedBeside));

// 待ちの表示に足す、同居させない組 (bdboard-xdk8) の説明。
export function blockedNote(plan, holder, options) {
  const { blocked } = plan;
  if (blocked === null) {
    return '';
  }
  const { waiter, other, otherRunning } = blocked;
  if (otherRunning && excludesOthers(other.priority, options.excludedBeside)) {
    return `; ${other.priority} verify pid ${other.pid} is running and ${waiter.priority} verifies do not run beside it — normal, do not kill it`;
  }
  const how = otherRunning ? 'to finish' : 'which starts first';
  if (waiter.pid === holder.pid) {
    return `; ${waiter.priority} verify does not run beside ${other.priority} verify pid ${other.pid}, waiting for it ${how}`;
  }
  return `; behind ${waiter.priority} verify pid ${waiter.pid}, which does not run beside ${other.priority} verify pid ${other.pid}`;
}

export function timeoutAdvice(plan, options) {
  const excluders = runningExcluders(plan, options);
  if (excluders.length > 0) {
    const pids = excluders.map((entry) => entry.pid).join(', ');
    return ` A ${excluders[0].priority} verify (pid ${pids}) is running: that is normal, do not kill it — retry after it finishes; do not disable the slot to get past this.`;
  }
  return ' Investigate those pids (hung verify?) before retrying; do not disable the slot to get past this.';
}
