// bdboard-ky9l: finish が状態ファイルに残す「着地後検証を実行中」の記録を読み、まだ有効かを判定する。
//
// 記録は 2 組 (どちらも finish が中断・クラッシュ・SIGKILL されると残る):
//   - verifyingPid / verifyingAt / verifyingStart — finish 自身の PID・書いた時刻・その PID の開始時刻
//   - verifyPgid / verifyPgidAt / verifyPgidStart — finish が起こした verify (detached) のプロセス
//     グループ id (= リーダーの PID)・起こした時刻・リーダーの開始時刻
// *Start は bdboard-ky9l で足した。無い記録 (bdboard-2hj4 以前・bdboard-ky9l 以前) は「判定できない」
// 側に倒し、従来どおり verifyingAt からの経過時間 (maxAgeMs) で古さを決める。
//
// 判定の優先順位 (PID だけが一致しても、その PID が今も記録したプロセスとは限らない):
//   1. 開始時刻が一致 → 同じプロセス。何時間経っていても「実行中」 (2 時間超の正規の実行・スリープ明け)。
//   2. 開始時刻が不一致 → PID が再利用されている。記録は古い (時間は見ない)。
//   3. 開始時刻を判定できない (記録に無い・ps が使えない・Windows) → 経過時間が maxAgeMs 以内なら実行中、
//      超えたら古い。経過時間が読めない旧形式は PID の生存だけで実行中とみなす。
import { compareStartTime, isProcessAlive, isProcessGroupAlive } from '../process-identity.mjs';

/** verifyingAt からの経過ミリ秒。時刻が無い・読めない記録は null (旧形式)。 */
function recordAgeMs(writtenAtText, now) {
  const writtenAt = typeof writtenAtText === 'string' ? Date.parse(writtenAtText) : Number.NaN;
  return Number.isFinite(writtenAt) ? now - writtenAt : null;
}

/**
 * identity ('same' | 'different' | 'unknown') と経過時間から、プロセスが「実行中か古い記録か」を決める。
 * 返り値: { running, stale?, identity, ageMs } — stale は running でないときの理由 ('reused' | 'aged')。
 */
function judge(identity, ageMs, maxAgeMs) {
  if (identity === 'same') {
    return { running: true, identity, ageMs };
  }
  if (identity === 'different') {
    return { running: false, stale: 'reused', identity, ageMs };
  }
  if (ageMs === null || ageMs <= maxAgeMs) {
    return { running: true, identity, ageMs };
  }
  return { running: false, stale: 'aged', identity, ageMs };
}

/**
 * verifyingPid の記録が、今も着地後検証を実行中の finish を指しているか。
 * 記録が無い・自分の PID・PID が居ない場合は { running: false } (stale も付かない = 何も言わずに進む)。
 * 自分と同じ PID の記録は、死んだ finish の PID がたまたま自分に再利用されたもの (bdboard-2hj4)。
 * deps はテストの差し替え口 ({ now, alive, compare })。
 */
export function judgeVerifyingPid(record, maxAgeMs, deps) {
  const options = deps || {};
  const now = options.now === undefined ? Date.now() : options.now;
  const alive = options.alive || isProcessAlive;
  const compare = options.compare || compareStartTime;
  const pid = record.verifyingPid;
  if (!pid || pid === process.pid || !alive(pid)) {
    return { running: false };
  }
  return judge(compare(pid, record.verifyingStart), recordAgeMs(record.verifyingAt, now), maxAgeMs);
}

/**
 * verifyPgid の記録が、finish が死んだ後も残っている孤児の verify プロセスグループを指しているか。
 * グループにまだ何か居ても、リーダーの PID が再利用されただけかもしれない (リーダーが死んでいて、
 * グループに他のメンバーが居る間は、その番号を別のプロセスが取ることはない — POSIX の規則なので
 * その場合は元のグループ。リーダーが生きているときだけ開始時刻で見分ける)。
 */
export function judgeVerifyGroup(record, maxAgeMs, deps) {
  const options = deps || {};
  const now = options.now === undefined ? Date.now() : options.now;
  const alive = options.alive || isProcessAlive;
  const groupAlive = options.groupAlive || isProcessGroupAlive;
  const compare = options.compare || compareStartTime;
  const pgid = record.verifyPgid;
  if (!pgid || !groupAlive(pgid)) {
    return { running: false };
  }
  if (!alive(pgid)) {
    return { running: true, identity: 'leaderless', ageMs: recordAgeMs(record.verifyPgidAt, now) };
  }
  return judge(compare(pgid, record.verifyPgidStart), recordAgeMs(record.verifyPgidAt, now), maxAgeMs);
}
