// bdboard-ky9l: finish が状態ファイルに残す「着地後検証を実行中」の記録 (verifyingPid / verifyPgid) の読み書き。
// 判定表そのものは verifying-record.mjs (純粋関数)。ここは finish の入口の関門 (RETRY 75 で止める・古い記録を
// 通知して無視する) と、記録の書き込み・消去を持つ。finish.mjs の行数を抑えるために切り出した。
// bdboard-h2fk: 孤児の verify グループへの案内 (groupInspectLines) と記録の書き方 (stampVerifyGroup) は、S2 prepare
// の着地予定ツリーの verify (predicted-guard.mjs) と共有する。
import { processStartTime } from '../process-identity.mjs';
import { EXIT, fail } from './context.mjs';
import { shellQuote } from './exec.mjs';
import { readState, say, writeState } from './state.mjs';
import { LEADERLESS_GROUP_MAX_AGE_MS, judgeVerifyGroup, judgeVerifyingPid } from './verifying-record.mjs';

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

/**
 * 検証を実行できなかったとき: 実行中の記録を外す (次の finish が RETRY で止まらないように)。
 * extra は同時に足す印 (bdboard-ulxa.7: クラス L の failure は landedResult: 'failure'。finish.mjs)。
 */
export function clearVerifyRecord(ctx, pr, extra = {}) {
  writeState(ctx.cwd, pr, { ...readState(ctx.cwd, pr), ...NO_VERIFY_RECORD, ...extra });
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
      `  PID が本当に finish か確かめる: ps -p ${shellQuote(String(pid))} -o lstart=,command=`,
    );
  }
  // finish が SIGKILL されても、detached で起こした verify のプロセスグループは生き残る。ここで進むと
  // 同じ worktree で 2 本目の verify が並走し、1 本目の restoreBranch が 2 本目の途中で木を差し替える。
  const groupVerdict = judgeVerifyGroup(record, VERIFYING_PID_MAX_AGE_MS);
  const pgid = record.verifyPgid;
  // bdboard-h2fk: 「古い記録を無視して進めます」という通知は、実際に進むと決まってから出す (先に出すと、続く
  // グループの判定で 75 になったとき、無視すると言ったのに止まる食い違いになる)。
  const pidNotice = stalePidNotice(pr, record, pidVerdict);
  if (groupVerdict.running) {
    fail(
      EXIT.RETRY,
      `PR #${pr} の前回の着地後検証 (verify のプロセスグループ ${shellQuote(String(pgid))}) がまだ動いています。二重に走らせません。`,
      ...(pidNotice === null
        ? [`  前回の finish (PID ${pid ?? '不明'}) は終わっています (SIGKILL などで中断された孤児の verify)。終わるのを待つか、畳んでから finish をやり直してください。`]
        : [
            `  ${pidNotice}`,
            '  その verifyingPid の記録は古いので当てにしませんが、verify のプロセスグループが残っているので、進まずここで止まります (記録を無視して進めるのではありません)。',
            '  終わるのを待つか、畳んでから finish をやり直してください。',
          ]),
      ...(groupVerdict.identity === 'leaderless' ? [leaderlessHeldLine(pgid, groupVerdict.ageMs)] : []),
      ...groupInspectLines(pgid),
    );
  }
  if (pidNotice !== null) {
    say(pidNotice, 'この記録は無視して、着地後検証を進めます。');
  }
  say(...groupProceedLines(pr, record, groupVerdict, '着地後検証を進めます'));
}

const minutes = (ms) => Math.round(ms / 60_000);

/**
 * verify グループの記録について、止めずに進むときの通知 (古い記録・不明)。無ければ空。proceeding は進む先を言う文言 (「着地後検証を進めます」など)。
 * bdboard-h2fk の「不明」: リーダーの居ないグループが上限を超えて残っている。元の verify とは言い切れない
 * (親が死ぬと verify は自分で畳むので、番号を再利用した無関係のデーモンの可能性が高い) ので、案内だけを出す。
 */
export function groupProceedLines(pr, record, verdict, proceeding) {
  const pgid = record.verifyPgid;
  if (verdict.stale) {
    return [`PR #${pr} の verify プロセスグループ ${pgid} の記録は、${verdict.stale === 'reused' ? '別のプロセスに再利用された' : '上限を超えた'}古い記録なので無視します。`];
  }
  if (verdict.unknown) {
    return [
      `PR #${pr} の verify プロセスグループ ${pgid} は、リーダー (PID ${pgid}) が居ないままメンバーだけが残っていて、記録 (${record.verifyPgidAt}, ${minutes(verdict.ageMs)} 分前) は上限 ${minutes(LEADERLESS_GROUP_MAX_AGE_MS)} 分を超えています。`,
      `  元の verify なら起こした側が死んだ時点で自分で畳むので、番号を再利用した無関係のグループの可能性が高く、元の verify かは不明です。止めずに、${proceeding}。`,
      '  前回の verify の残りかもしれないと思うなら、先に中身を確かめてください (確かめずに kill しない):',
      ...groupInspectLines(pgid),
    ];
  }
  return [];
}

/** 開始時刻の不一致か上限超過で「古い」と判定された verifyingPid の記録の説明 (古くなければ null)。 */
function stalePidNotice(pr, record, verdict) {
  const pid = record.verifyingPid;
  if (verdict.stale === 'reused') {
    return `PR #${pr} の verifyingPid ${pid} は、記録した finish プロセス (開始 ${record.verifyingStart}) ではなく別のプロセス (開始 ${processStartTime(pid) ?? '不明'}) です。PID が再利用された古い記録です。`;
  }
  if (verdict.stale === 'aged') {
    return `PR #${pr} の verifyingPid ${pid} は ${record.verifyingAt} (${minutes(verdict.ageMs)} 分前) の記録で、上限 ${minutes(VERIFYING_PID_MAX_AGE_MS)} 分を超えています。PID 再利用などの古い記録です。`;
  }
  return null;
}

/** リーダー不在のグループを元の verify として止めるときの、いつまで止まるかの説明。 */
export function leaderlessHeldLine(pgid, ageMs) {
  const age = ageMs === null ? '記録の時刻が読めない' : `記録から ${minutes(ageMs)} 分`;
  return `  リーダー (PID ${pgid}) は終わっていますがメンバーが残っています (${age})。上限 ${minutes(LEADERLESS_GROUP_MAX_AGE_MS)} 分以内なので前回の verify の残りとみなして止めます。上限を超えると元の verify かは不明として、案内だけを出して止めません。`;
}

/**
 * 孤児かもしれない verify グループへの案内 (bdboard-h2fk)。中身を確かめる pgrep を必ず先に出し、畳む kill はその後に
 * 添える — 番号を再利用した無関係のグループを、確かめないまま畳ませないため。
 */
export function groupInspectLines(pgid) {
  const group = shellQuote(String(pgid));
  return [`  確かめる: pgrep -g ${group} -l`, `  前回の verify の残りと確かめてから畳む: kill -TERM -${group} (残るなら kill -KILL -${group})`];
}

/**
 * verify を起こした直後に、そのプロセスグループ (detached なので子の PID = グループ id) の記録を write(fields) で残す。
 * グループ id を先に書き、開始時刻は ps の後で足す。ps (重い負荷では数秒) の間に起こした側が SIGKILL されても孤児の
 * グループを記録し損ねない (開始時刻の無い記録は、リーダー無し・経過時間で判定される)。
 */
export function stampVerifyGroup(child, write) {
  if (child.pid === undefined || process.platform === 'win32') {
    return; // 起動に失敗した (error イベントで 127 になる)、またはプロセスグループが無い
  }
  try {
    const stamped = { verifyPgid: child.pid, verifyPgidAt: new Date().toISOString(), verifyPgidStart: null };
    write(stamped);
    write({ ...stamped, verifyPgidStart: processStartTime(child.pid) });
  } catch {
    // 記録できなくても検証は続ける (孤児の検出が効かなくなるだけ)。
  }
}

/** finish: verify を起こした直後に、そのプロセスグループを状態ファイルへ残す。 */
export function recordVerifyGroup(ctx, pr, child) {
  const current = readState(ctx.cwd, pr);
  if (current === null) {
    return;
  }
  stampVerifyGroup(child, (fields) => writeState(ctx.cwd, pr, { ...current, ...fields }));
}
