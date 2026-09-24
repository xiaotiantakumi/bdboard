// bdboard-ulxa.6: verify スロットの「誰が次に走るか」を決める純関数 (ファイル I/O なし)。
//
// 背景: マージ手順 S2 では、着地予定ツリーの verify (predicted) と着地後検証 (landed) が
// マージのクリティカルパスに乗る。スロット (既定 2) を FIFO で配ると、PR 前の手元 verify の
// 後ろに並び、終わるころには main が進んでいてやり直しになっていた (2026-09-25 観測: 並列 7 本で
// PR #740 が 5 回やり直し)。そこで上限本数は変えずに、空いた枠を「どの待ち手に渡すか」の
// 順番だけに優先度を入れる。
//
// 優先度 (holder.priority。環境変数 BDBOARD_VERIFY_PRIORITY で渡す):
//   landed … 着地後検証 (merge-pr finish / gate の自己修復 / merge-pr verify)。次の gate は
//            PRED_BASE の台帳 success を待つので、main の先頭の着地後検証は全 PR のマージを止める
//   merge  … 着地予定ツリーの verify (merge-pr prepare のクラス F)
//   pr     … それ以外 (PR 前の手元 verify)。既定値
//
// 飢餓防止は「仮想到着時刻」: key = 到着時刻 + 段数 × tierStepMs (既定 4 分) の小さい順に渡す。
// 1 段下の待ち手は tierStepMs 遅く着いた扱いになるだけなので、それより後に着いた上位の待ち手には
// 抜かれない (待ち時間の上限 = FIFO の待ち + 段数 × tierStepMs)。gfqz (PR #728) の「連続 N 回で
// 下位へ強制」と同じ目的を、状態を共有しないプロセス間でも決定的に効く形にしたもの。
// holder.since (BDBOARD_VERIFY_QUEUE_SINCE) は merge-pr が渡す「この PR が最初に並んだ時刻」で、
// main が動いて並び直した PR が新顔に抜かれないようにする (maxSeniorityMs で頭打ち)。
//
// 旧形式 (holder.v が無い = bdboard-d48 のスクリプト) との混在: 旧プロセスは (joinedAt, pid) の
// FIFO 順位 < slots で走り出し、走り出したことをファイルに書かない。そこで
//   - 旧 holder が走っているかは、旧プロセス自身と同じ計算 (legacyRank) で推定する
//   - 旧 holder が待っている間は、それより前に着いた新形式の待ち手しか枠を取らない (barrier)。
//     新形式が旧 holder を追い越して走ると、旧プロセスの順位計算にその新形式が映らず、
//     上限を 1 本超えうるため
// 新形式は走り出すときに acquiredAt を書く (旧プロセスは知らないフィールドを無視する)。
// verify.mjs の import graph に入るので、古い Node でもパースできる構文に保つこと (bdboard-eu2k)。
export const HOLDER_FORMAT = 2;
export const PRIORITY_RANK = Object.freeze({ landed: 0, merge: 1, pr: 2 });
export const DEFAULT_PRIORITY = 'pr';

export function normalizePriority(value) {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(PRIORITY_RANK, value) ? value : DEFAULT_PRIORITY;
}

function isCurrentFormat(holder) {
  return holder.v === HOLDER_FORMAT;
}

function byArrival(a, b) {
  return a.joinedAt - b.joinedAt || a.pid - b.pid;
}

/** 旧スクリプトが holder 自身の目で計算する順位 (自分以外で、stale でなく、先に着いた holder の数)。 */
export function legacyRank(holder, holders, now, staleTtlMs) {
  let rank = 0;
  for (const other of holders) {
    if (other.pid !== holder.pid && now - other.joinedAt <= staleTtlMs && byArrival(other, holder) < 0) {
      rank += 1;
    }
  }
  return rank;
}

/** 並び順の鍵 (仮想到着時刻)。小さいほど先。 */
export function queueKey(holder, { tierStepMs, maxSeniorityMs }) {
  const rank = PRIORITY_RANK[normalizePriority(holder.priority)];
  let since = holder.joinedAt;
  if (typeof holder.since === 'number' && Number.isFinite(holder.since)) {
    since = Math.min(holder.joinedAt, Math.max(holder.since, holder.joinedAt - maxSeniorityMs));
  }
  return since + rank * tierStepMs;
}

/**
 * holders (生きている holder の一覧。自分を含む) から、自分が今走ってよいかを決める。
 * @returns {{ acquire: boolean, running: object[], queue: object[], position: number, stale: object[] }}
 *   running = 枠を使っているとみなす holder、queue = 待ち手の並び (先頭が次)、position = 自分の
 *   queue 内の順位 (1 始まり)、stale = staleTtlMs を超えて数から外した holder
 */
export function planSlots(holders, { selfPid, slots, now, staleTtlMs, tierStepMs, maxSeniorityMs }) {
  const running = [];
  const waiting = [];
  const legacyWaiting = [];
  const stale = [];
  for (const holder of holders) {
    const self = holder.pid === selfPid;
    if (isCurrentFormat(holder) && typeof holder.acquiredAt === 'number') {
      // 走っている新形式は「走り始めてから」staleTtlMs で外す (待ち時間を数えない)。
      (!self && now - holder.acquiredAt > staleTtlMs ? stale : running).push(holder);
    } else if (!self && now - holder.joinedAt > staleTtlMs) {
      stale.push(holder);
    } else if (isCurrentFormat(holder) || self) {
      waiting.push(holder);
    } else if (legacyRank(holder, holders, now, staleTtlMs) < slots) {
      running.push(holder);
    } else {
      legacyWaiting.push(holder);
    }
  }
  const keyOptions = { tierStepMs, maxSeniorityMs };
  const blockedByLegacy = (holder) => legacyWaiting.some((legacy) => byArrival(legacy, holder) < 0);
  const eligible = waiting
    .filter((holder) => !blockedByLegacy(holder))
    .sort((a, b) => queueKey(a, keyOptions) - queueKey(b, keyOptions) || byArrival(a, b));
  const queue = [...eligible, ...[...waiting.filter(blockedByLegacy), ...legacyWaiting].sort(byArrival)];
  const selfIndex = eligible.findIndex((holder) => holder.pid === selfPid);
  return {
    acquire: selfIndex >= 0 && selfIndex < slots - running.length,
    running,
    queue,
    position: queue.findIndex((holder) => holder.pid === selfPid) + 1,
    stale,
  };
}
