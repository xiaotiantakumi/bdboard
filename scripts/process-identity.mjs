// bdboard-ky9l: プロセスの生存確認。
//
// 生存確認 (isProcessAlive) は、もとは scripts/merge-pr/finish.mjs の pidAlive と
// scripts/verify-slot-files.mjs の isProcessAlive の 2 か所に同じ中身で書かれていた。ここへ 1 つに
// まとめた。PID は再利用されるので、「kill(pid, 0) が通る」だけでは「記録を書いたプロセスがまだ居る」
// とは言えない。bdboard-wea0.2: merge-pr の verify の持ち主を開始時刻で確かめる半分 (processStartTime /
// compareStartTime) は、worktree lock (scripts/worktree-lock.mjs) に置き換えて消した。ここに残るのは verify スロットの
// holder ファイルと merge-pr の中断処理 (interrupt.mjs) が使う生存確認だけ。
//
// 制約: このファイルは scripts/verify.mjs → verify-slot.mjs → verify-slot-files.mjs から import される
// ので、古い Node でもパースできる構文・API に保つこと (bdboard-eu2k。目安の下限は v14.13.1)。
// `||=` / `??=` などの新しい構文と、`Array.prototype.at` / `Object.hasOwn` / `structuredClone` 等の
// v14 に無い API を使わない。`?.` / `??` も、同じ判定を書いている verify-slot-files.mjs に合わせて避ける。
function isPositiveInteger(value) {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

/**
 * pid のプロセスが居るか。EPERM は「居るが触れない」なので居る側に倒す (同一ユーザーの運用ではまず
 * 出ないが、出たときに「居ない」と誤って記録を回収するより安全)。pid が正の整数でなければ false
 * (process.kill(0, 0) は自分のプロセスグループ宛てで成功してしまうため、ここで弾く)。
 */
export function isProcessAlive(pid) {
  if (!isPositiveInteger(pid)) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error) && error.code === 'EPERM';
  }
}

/**
 * pgid をリーダーとするプロセスグループにまだ何か居るか (POSIX)。ESRCH だけを「空」とみなす。
 * win32 にはプロセスグループが無い (process-tree.mjs と同じ事情) ので常に false。
 */
export function isProcessGroupAlive(pgid, deps) {
  const platform = (deps && deps.platform) || process.platform;
  if (platform === 'win32' || !isPositiveInteger(pgid)) {
    return false;
  }
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return !(Boolean(error) && error.code === 'ESRCH');
  }
}
