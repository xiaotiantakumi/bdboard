// bdboard-ulxa.1: 層1 の協調ロック (bd merge-slot) の取得・返却。
//
// - `--wait` は使わない (waiters の残骸で順番が来ない。failure-catalog の merge-slot-waiters-stale)
// - 他人の枠は release しない。空かなければ slotWaitMinutes で諦めて RETRY を返し、
//   握りっぱなしの holder は議長に報告させる (委譲ブリーフの規律。設計 §3.7 の
//   「LEASE 超過なら release してから acquire」は採らない)
// - 自分と同じ holder 名 (= 同じ PR の前回の gate) が握っているときだけ、それを引き継ぐ
import { run } from './exec.mjs';
import { say } from './state.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function pollMs() {
  const raw = Number(process.env.BDBOARD_MERGE_POLL_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 30_000;
}

function slotHolder(cwd) {
  const checked = run('bd', ['merge-slot', 'check', '--json'], { cwd });
  if (checked.status !== 0) {
    return null;
  }
  try {
    const parsed = JSON.parse(checked.stdout);
    return typeof parsed.holder === 'string' && parsed.available !== true ? parsed.holder : null;
  } catch {
    return null;
  }
}

/**
 * 枠を取る。取れたら { ok: true }、期限切れ・main が動いたら { ok: false, reason, holder }。
 */
export async function acquireSlot(cwd, holder, { waitMinutes, mainMoved }) {
  const deadline = Date.now() + waitMinutes * 60_000;
  for (;;) {
    if (slotHolder(cwd) === holder) {
      say(`枠は既に ${holder} (この PR の前回の gate) が保持しています。引き継ぎます。`);
      return { ok: true };
    }
    const acquired = run('bd', ['merge-slot', 'acquire', '--holder', holder], { cwd });
    if (acquired.status === 0) {
      return { ok: true };
    }
    const other = slotHolder(cwd);
    say(`枠が空いていません (${(other ?? acquired.stderr.trim()) || 'held'})。`);
    if (Date.now() >= deadline) {
      return { ok: false, reason: 'timeout', holder: other };
    }
    await sleep(pollMs());
    if (mainMoved()) {
      return { ok: false, reason: 'moved', holder: other };
    }
  }
}

/** 自分の枠を返す。失敗したら手で打つコマンドを案内する (握りっぱなしにしない)。 */
export function releaseSlot(cwd, holder) {
  const released = run('bd', ['merge-slot', 'release', '--holder', holder], { cwd });
  if (released.status !== 0) {
    say(
      `枠の返却に失敗しました: ${released.stderr.trim()}`,
      `手で返してください: bd merge-slot release --holder '${holder}'`,
    );
    return false;
  }
  return true;
}
