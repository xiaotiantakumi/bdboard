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
// verify グループのリーダーが死んでいてメンバーだけが居る場合 (judgeVerifyGroup) は開始時刻を比べられない
// (比べる相手のリーダーが居ない) ので、経過時間の上限 LEADERLESS_GROUP_MAX_AGE_MS で「実行中」と「不明」を分ける
// (bdboard-h2fk)。
import { compareStartTime, isProcessAlive, isProcessGroupAlive } from '../process-identity.mjs';

// bdboard-h2fk: リーダーが死んでメンバーだけが居る verify グループを「元の verify の孤児」とみなす、verifyPgidAt
// からの上限。これを超えたグループは「不明」として案内だけを出し、止めない (finish を 75 で止め続けない)。
// 根拠: bash が npm を exec するので、npm がこのグループのリーダーで、verify.mjs はその直接の子。起こした側
// (finish / prepare) が SIGKILL されても、グループは孤児として残る (そのための記録)。npm が死ぬと verify.mjs は
// PPID=1 を見て 1 秒ほどで終わる。だからリーダーの居ないグループが長く生きているなら、元の verify ではなく、
// 番号を再利用した無関係の二重 fork デーモン (setsid して子を残して親が終わった) である可能性が高い。
// 例外: verify.mjs が孤児を見張り始めるのは verify スロットを取った後。スロット待ちの間は、リーダー不在の元の
// グループがその待ち時間だけ生き残りうる (待ちに上限が無いことは verify-guard.mjs の VERIFYING_PID_MAX_AGE_MS)。
// それを元の verify と読み続けると 75 が永久に消えず、kill -TERM -<pgid> の案内が無関係のグループを指す。
// 値は、verify が正規に走っていられる時間より十分長く取る。着地後検証の実測 (verify-guard.mjs の
// VERIFYING_PID_MAX_AGE_MS のコメントと同じログ 133 件) は、通常 4〜5 分、スロット待ちが最大 685 秒、vitest が
// 最大約 524 秒で、重い負荷の下でも長くて 10〜20 分。2 時間はその 6〜12 倍で、VERIFYING_PID_MAX_AGE_MS と同じ値。
// 短すぎる害は、本当に走っている孤児の裏で 2 本目の verify が同じ worktree に並走すること (1 本目の
// restoreBranch が 2 本目の途中で木を差し替える)。長すぎる害は、孤児でないグループのために待つだけで、しかも
// 案内に pgrep の確認が付く。害が非対称なので、短くするより長めに倒した。
// 受け入れている穴: 孤児が居る間にマシンが 2 時間以上スリープすると、壁時計の経過は上限を超えるが verify は
// 進んでいない。スロットを取った後の孤児なら、起き次第 PPID=1 を見て自分で畳む。スロット待ちの最中だった孤児は
// 待ちが続く限り残る。どちらの場合も、案内の pgrep が最後の確認になる。
export const LEADERLESS_GROUP_MAX_AGE_MS = 2 * 60 * 60_000;

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
 *
 * bdboard-h2fk: リーダー不在のグループは、それが同じ番号を別のプロセスが取って作った無関係のグループなのか、元の
 * verify なのかを開始時刻で見分けられない (リーダーが居ない)。そこで verifyPgidAt からの経過時間が
 * LEADERLESS_GROUP_MAX_AGE_MS (deps.leaderlessMaxAgeMs で差し替え可) 以内なら実行中、超えたら「不明」にする。
 * 「不明」の返り値は { running: false, unknown: true, identity: 'leaderless', ageMs }: 止めずに案内だけを出す
 * (verify-guard.mjs)。経過時間が読めない記録は、従来どおり実行中 (止める側) に倒す。
 */
export function judgeVerifyGroup(record, maxAgeMs, deps) {
  const options = deps || {};
  const now = options.now === undefined ? Date.now() : options.now;
  const alive = options.alive || isProcessAlive;
  const groupAlive = options.groupAlive || isProcessGroupAlive;
  const compare = options.compare || compareStartTime;
  const leaderlessMaxAgeMs = options.leaderlessMaxAgeMs === undefined ? LEADERLESS_GROUP_MAX_AGE_MS : options.leaderlessMaxAgeMs;
  const pgid = record.verifyPgid;
  if (!pgid || !groupAlive(pgid)) {
    return { running: false };
  }
  const ageMs = recordAgeMs(record.verifyPgidAt, now);
  if (!alive(pgid)) {
    if (ageMs !== null && ageMs > leaderlessMaxAgeMs) {
      return { running: false, unknown: true, identity: 'leaderless', ageMs };
    }
    return { running: true, identity: 'leaderless', ageMs };
  }
  return judge(compare(pgid, record.verifyPgidStart), ageMs, maxAgeMs);
}
