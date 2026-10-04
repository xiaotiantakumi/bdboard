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
// 抜かれない (pr を抜けるのは、pr より 8 分以内に並んだ landed と、since の分を足して 14 分以内に
// 並んだ merge だけ)。gfqz (PR #728) の「連続 N 回で
// 下位へ強制」と同じ目的を、状態を共有しないプロセス間でも決定的に効く形にしたもの。
// holder.since (BDBOARD_VERIFY_QUEUE_SINCE) は merge-pr が渡す「この PR が最初に並んだ時刻」で、
// main が動いて並び直した PR が新顔に抜かれないようにする (maxSeniorityMs = 10 分で頭打ち。
// 30 分にしてもシミュレーションの結果は同じで、下位の待ちの上限だけが延びる)。
//
// 長く待っている新形式の待ち手は、他の holder から stale (joinedAt から staleTtlMs) と見なされる
// 前に並び直す (joinedAt を今にする。verify-slot.mjs)。順番は変えないよう、並び順は queuedAt
// (最初に並んだ時刻) から計算する。stale と見なされたまま自分だけ枠を取ると、他の待ち手からは
// 見えないので上限を超えうる — planSlots も、自分が stale の年齢なら取らない。
//
// 旧形式 (holder.v が無い = bdboard-d48 のスクリプト) との混在: 旧プロセスは (joinedAt, pid) の
// FIFO 順位 < slots で走り出し、走り出したことをファイルに書かない。そこで
//   - 旧 holder が走っているかは、旧プロセス自身と同じ計算 (legacyRank) で推定する
//   - 旧 holder が待っている間は、それより前に着いた新形式の待ち手しか枠を取らない (barrier)。
//     新形式が旧 holder を追い越して走ると、旧プロセスの順位計算にその新形式が映らず、
//     上限を 1 本超えうるため
// 新形式は走り出すときに acquiredAt を書く (旧プロセスは知らないフィールドを無視する)。
//
// bdboard-xdk8: 同居させない組 (EXCLUDED_BESIDE)。landed (着地後検証) は pr (PR 前の手元 verify) と同時に
// 走らせない — 順番が来ても pr が走っていれば始めず (抜けるのを待つ)、landed が走っている間は pr を始めない。
// 2026-10-04 に、着地後検証が verify スロット 2 本 + スロット外の負荷 (load average 48〜111、10 コア) のなかで
// 5000ms タイムアウト等の偽の failure を 2 回出し、main-broken の枠で全マージが止まった。その時間帯に landed と
// 同居していたのは pr だけで、merge (着地予定ツリー) は 1 本も無かった。監査ログでは landed と merge の同居が
// 約 12 回あり全部 success だったので、merge とは今までどおり枠を分け合う (landed の完全な独占は、7 エージェントの
// シミュレーションでマージ数が 44.3 → 28.4、最大待ちが 88.5 → 263 分になる。docs/VERIFY.md「Priorities」)。
// 並び順 (仮想到着時刻) は変えない。先頭から順に始め、同居させない相手 (走っている holder か、この周に先に始める
// 待ち手) が居る待ち手で止まる (止まった先頭)。その後ろの pr と landed は飛ばさない (どれも同居の規則に関わるので、
// 飛ばすと先頭が飢えうる)。規則に関わらない merge だけは、空き枠があれば止まった先頭を飛ばして始めてよい: landed と
// merge は同居させてよい (上の監査ログ) ので、pr が走っている間に待つ landed の後ろで merge まで止めると枠が遊ぶ。
// 先頭は相手が抜けた周に空いた枠を真っ先に取るので飢えない (シミュレーションで飛ばさない場合に比べてマージ数
// 44.3 → 45.8、最大待ち 88.5 → 53.4 分、やり直しの最大 7 → 5。docs/VERIFY.md「Priorities」)。skipPastBlocked: false は飛ばさない比較用 (verify-slot-sim.mjs)。
// 予約 (reserved) と再実行 (retry) の landed holder は since を頭打ちにしない (queueKey、bdboard-xdk8): merge-pr が
// 負荷由来の失敗を 1 回だけ再実行するとき、1 回目に並んだ時刻のまま並び直すため (10 分で頭打ちにすると、それより
// 長く待っていた pr に抜かれ、再実行がその pr の後ろで待つ)。
// 旧形式・この変更より前の新形式 (同居の規則を知らないスクリプト = rebase していない worktree) は landed を 1 本と
// 数えて隣で走りうる。その分は今日までと同じ (悪くはならない) ので、移行の手当てはしない。
// verify.mjs の import graph に入るので、古い Node でもパースできる構文に保つこと (bdboard-eu2k)。
export const HOLDER_FORMAT = 2;
export const PRIORITY_RANK = Object.freeze({ landed: 0, merge: 1, pr: 2 });
export const DEFAULT_PRIORITY = 'pr';
export const TIER_STEP_MS = 4 * 60_000;
export const MAX_SENIORITY_MS = 10 * 60_000;
/** 優先度 → それと同時に走らせない優先度 (bdboard-xdk8)。関係は両向きに効く (conflict)。 */
export const EXCLUDED_BESIDE = Object.freeze({ landed: Object.freeze(['pr']) });

export function normalizePriority(value) {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(PRIORITY_RANK, value) ? value : DEFAULT_PRIORITY;
}

/** a と b が同時に走ってはいけないか (excludedBeside をどちら向きに見ても)。 */
export function conflict(a, b, excludedBeside = EXCLUDED_BESIDE) {
  const first = normalizePriority(a.priority);
  const second = normalizePriority(b.priority);
  return (excludedBeside[first] ?? []).includes(second) || (excludedBeside[second] ?? []).includes(first);
}

/** 他の優先度を止める側か (landed。待ちの打ち切りを延ばす・表示を出し分けるのに使う。verify-slot.mjs)。 */
export function excludesOthers(priority, excludedBeside = EXCLUDED_BESIDE) {
  return (excludedBeside[normalizePriority(priority)] ?? []).length > 0;
}

/** 同居の規則にどちら側でも関わらない優先度か (merge)。止まった先頭を飛ばしてよいのはこれだけ (pickStarters)。 */
export function isNeutral(priority, excludedBeside = EXCLUDED_BESIDE) {
  const own = normalizePriority(priority);
  return !Object.keys(excludedBeside).some((key) => key === own || excludedBeside[key].includes(own));
}

/** merge-pr の再実行の席を持つ landed holder か (予約 = reserved、予約を引き継いだ再実行 = retry)。since を頭打ちにしない。 */
export function holdsRetryPlace(holder) {
  return (holder.reserved === true || holder.retry === true) && normalizePriority(holder.priority) === 'landed';
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
  const queuedAt = isFiniteNumber(holder.queuedAt) ? Math.min(holder.queuedAt, holder.joinedAt) : holder.joinedAt;
  let since = queuedAt;
  if (isFiniteNumber(holder.since)) {
    since = Math.min(queuedAt, holdsRetryPlace(holder) ? holder.since : Math.max(holder.since, queuedAt - maxSeniorityMs));
  }
  return since + rank * tierStepMs;
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * holders (生きている holder の一覧。自分を含む) から、自分が今走ってよいかを決める。
 * @returns {{ acquire: boolean, running: object[], queue: object[], position: number, stale: object[], blocked: object | null }}
 *   running = 枠を使っているとみなす holder、queue = 待ち手の並び (先頭が次)、position = 自分の
 *   queue 内の順位 (1 始まり)、stale = staleTtlMs を超えて数から外した holder、blocked = 自分 (または
 *   自分より前の止まった先頭) が同居させない相手のせいで始められないとき、その組 { waiter, other, otherRunning }
 *   (other = 走っている holder か、この周に先に始める待ち手。bdboard-xdk8。表示と待ちの打ち切りの延長に使う)。
 *   無ければ null (飛ばしてよい merge は、空き枠を待っているだけなので null)
 */
export function planSlots(
  holders,
  { selfPid, slots, now, staleTtlMs, tierStepMs, maxSeniorityMs, excludedBeside = EXCLUDED_BESIDE, skipPastBlocked = true },
) {
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
  // 他の holder から stale と見なされる年齢の待ち手は取らない (並び直してから)。
  const selfVisible = eligible.some((holder) => holder.pid === selfPid && now - holder.joinedAt <= staleTtlMs);
  const canSkip = (holder) => skipPastBlocked && isNeutral(holder.priority, excludedBeside);
  const picked = pickStarters(eligible, running, slots, (a, b) => conflict(a, b, excludedBeside), canSkip);
  const selfIndex = eligible.findIndex((holder) => holder.pid === selfPid);
  const heldBack = picked.blocked !== null && selfIndex >= picked.blocked.index && !canSkip(eligible[selfIndex]);
  const blocked = heldBack ? picked.blocked : null;
  return {
    acquire: selfVisible && picked.starters.some((holder) => holder.pid === selfPid),
    running,
    queue,
    position: queue.findIndex((holder) => holder.pid === selfPid) + 1,
    stale,
    blocked: blocked && { waiter: blocked.waiter, other: blocked.other, otherRunning: blocked.otherRunning },
  };
}

/**
 * 並び順 (eligible) の先頭から「今始めてよい待ち手」を選ぶ (bdboard-xdk8)。空き枠 = slots - 走っている数。
 * 順に見て、空き枠が尽きたら止まる。走っている holder かこの周に選んだ待ち手と同居させない待ち手は始めず、
 * そこが止まった先頭になる。その後ろは canSkip (同居の規則に関わらない merge) の待ち手だけを空き枠に入れ、
 * pr と landed は飛ばさない。blocked = 止まった先頭の { index, waiter, other, otherRunning }。
 */
function pickStarters(eligible, running, slots, conflicts, canSkip) {
  let free = slots - running.length;
  const starters = [];
  let blocked = null;
  for (let index = 0; index < eligible.length && free > 0; index += 1) {
    const waiter = eligible[index];
    if (blocked !== null && !canSkip(waiter)) {
      continue;
    }
    const other = running.find((holder) => conflicts(waiter, holder)) ?? starters.find((holder) => conflicts(waiter, holder));
    if (other !== undefined) {
      blocked = { index, waiter, other, otherRunning: running.includes(other) };
      continue;
    }
    starters.push(waiter);
    free -= 1;
  }
  return { starters, blocked };
}
