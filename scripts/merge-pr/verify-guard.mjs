// bdboard-ky9l: finish が状態ファイルに残す「着地後検証を実行中」の記録 (verifyingPid / verifyPgid) の読み書き。
// 判定表そのものは verifying-record.mjs (純粋関数)。ここは finish の入口の関門 (RETRY 75 で止める・古い記録を
// 通知して無視する) と、記録の書き込み・消去を持つ。finish.mjs の行数を抑えるために切り出した。
import { processStartTime } from '../process-identity.mjs';
import { EXIT, fail } from './context.mjs';
import { readState, say, writeState } from './state.mjs';
import { judgeVerifyGroup, judgeVerifyingPid } from './verifying-record.mjs';

// bdboard-2hj4: verifyingPid の記録を「実行中」とみなす上限。状態ファイル (state.mjs) は finish が
// 中断・クラッシュしても残るので、書いた PID が後で別プロセスに再利用される (isProcessAlive は EPERM も
// alive 扱い) と、記録が永久に「二重に走らせません」(RETRY 75) になる。そこで verifyingAt (書いた時刻)
// からこの時間を超えた記録は、PID が生きていても古い記録として無視する。
// 値は、finish が正規に走っていられる時間より十分長く取る。verify スロットの待ちには上限が無い
// (waitTimeoutMs 15 分が効くのは走っている holder の顔ぶれが 15 分変わらないときだけで、列が進んで
// いる間は待ち続ける。verify-slot.mjs)。ほかに lockfile が変わったときの npm ci と、ネットワーク
// 呼び出しのタイムアウト (各 120 秒、exec.mjs) も足される。実測では landed-verify のログ 133 件で
// スロット待ちが最大 685 秒、vitest の合計が最大約 524 秒、finish から着地後検証の完了までは通常
// 4〜5 分なので、2 時間は十分に長い。並んだ時刻の記録を捨てる SENIORITY_RESET_MS (verify-queue.mjs)
// と同じ値にそろえた。短すぎると、本当に走っている finish と同じ worktree で 2 本目の verify が並走し、
// 1 本目の restoreBranch (landed-verify.mjs) が 2 本目の途中で木を差し替えて誤った結果を台帳に書く
// (長すぎる害は待つだけ)。
// bdboard-ky9l: この上限は、記録したプロセスと PID の現在の持ち主が同一かを開始時刻で判定できないとき
// (旧形式の記録・ps が使えない環境・Windows) のフォールバックになった。開始時刻が取れるときは
// verifying-record.mjs が同一性で決める: 同一なら 2 時間を超えても実行中、別なら (記録が新しくても)
// PID 再利用の古い記録。
export const VERIFYING_PID_MAX_AGE_MS = 2 * 60 * 60_000;

// 実行中の記録を全部外した状態 (finish が検証を実行できなかったとき・新しく検証を始めるときの初期値)。
const NO_VERIFY_RECORD = {
  verifyingPid: null,
  verifyingAt: null,
  verifyingStart: null,
  verifyPgid: null,
  verifyPgidAt: null,
  verifyPgidStart: null,
};

/** 状態ファイルに足す「いま自分が着地後検証を始める」記録。前回の verify グループの記録は、この実行のものではないので消す。 */
export function verifyingStamp() {
  return { ...NO_VERIFY_RECORD, verifyingPid: process.pid, verifyingAt: new Date().toISOString(), verifyingStart: processStartTime(process.pid) };
}

/** 検証を実行できなかったとき: 実行中の記録を外す (次の finish が RETRY で止まらないように)。 */
export function clearVerifyRecord(ctx, pr) {
  writeState(ctx.cwd, pr, { ...readState(ctx.cwd, pr), ...NO_VERIFY_RECORD });
}

/**
 * 状態ファイルに残った verifyingPid / verifyPgid の記録を調べ、着地後検証がまだ動いているなら RETRY (75) で
 * 止める (何も触らない)。古い記録は通知して無視し、進める。
 */
export function guardAgainstRunningVerify(pr, record) {
  const pidVerdict = judgeVerifyingPid(record, VERIFYING_PID_MAX_AGE_MS);
  const pid = record.verifyingPid;
  if (pidVerdict.running) {
    const expiry =
      pidVerdict.identity === 'same'
        ? `PID ${pid} は記録した finish プロセス (開始 ${record.verifyingStart}) と同一なので、何時間経っていても古い記録とはみなしません。`
        : pidVerdict.ageMs === null
          ? '記録に時刻が無い (旧形式) ので、PID が終わるまで古い記録とはみなしません。'
          : `開始時刻を確かめられないので、記録は ${record.verifyingAt} で、あと ${Math.ceil((VERIFYING_PID_MAX_AGE_MS - pidVerdict.ageMs) / 60_000)} 分で古い記録として扱います。`;
    fail(
      EXIT.RETRY,
      `PR #${pr} の着地後検証は PID ${pid} で実行中です。二重に走らせません。`,
      `  ${expiry}`,
      `  PID が本当に finish か確かめる: ps -p ${pid} -o lstart=,command=`,
    );
  }
  if (pidVerdict.stale === 'reused') {
    say(
      `PR #${pr} の verifyingPid ${pid} は、記録した finish プロセス (開始 ${record.verifyingStart}) ではなく別のプロセス (開始 ${processStartTime(pid) ?? '不明'}) です。`,
      'PID が再利用された古い記録とみなして無視し、着地後検証を進めます。',
    );
  } else if (pidVerdict.stale === 'aged') {
    say(
      `PR #${pr} の verifyingPid ${pid} は ${record.verifyingAt} (${Math.round(pidVerdict.ageMs / 60_000)} 分前) の記録で、上限 ${Math.round(VERIFYING_PID_MAX_AGE_MS / 60_000)} 分を超えています。`,
      'PID 再利用などの古い記録とみなして無視し、着地後検証を進めます。',
    );
  }
  // finish が SIGKILL されても、detached で起こした verify のプロセスグループは生き残る。ここで進むと
  // 同じ worktree で 2 本目の verify が並走し、1 本目の restoreBranch が 2 本目の途中で木を差し替える。
  const groupVerdict = judgeVerifyGroup(record, VERIFYING_PID_MAX_AGE_MS);
  const pgid = record.verifyPgid;
  if (groupVerdict.running) {
    fail(
      EXIT.RETRY,
      `PR #${pr} の前回の着地後検証 (verify のプロセスグループ ${pgid}) がまだ動いています。二重に走らせません。`,
      `  前回の finish (PID ${pid ?? '不明'}) は終わっています (SIGKILL などで中断された孤児の verify)。終わるのを待つか、畳んでから finish をやり直してください。`,
      `  確かめる: pgrep -g ${pgid} -l`,
      `  畳む: kill -TERM -${pgid} (残るなら kill -KILL -${pgid})`,
    );
  }
  if (groupVerdict.stale) {
    say(
      `PR #${pr} の verify プロセスグループ ${pgid} の記録は、${groupVerdict.stale === 'reused' ? '別のプロセスに再利用された' : '上限を超えた'}古い記録なので無視します。`,
    );
  }
}

/** verify を起こした直後に、そのプロセスグループ (detached なので子の PID = グループ id) を状態ファイルへ残す。 */
export function recordVerifyGroup(ctx, pr, child) {
  if (child.pid === undefined || process.platform === 'win32') {
    return; // 起動に失敗した (error イベントで 127 になる)、またはプロセスグループが無い
  }
  const current = readState(ctx.cwd, pr);
  if (current === null) {
    return;
  }
  try {
    writeState(ctx.cwd, pr, {
      ...current,
      verifyPgid: child.pid,
      verifyPgidAt: new Date().toISOString(),
      verifyPgidStart: processStartTime(child.pid),
    });
  } catch {
    // 記録できなくても検証は続ける (孤児の検出が効かなくなるだけ)。
  }
}
