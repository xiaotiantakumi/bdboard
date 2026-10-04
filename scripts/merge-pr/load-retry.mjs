// bdboard-xdk8: 着地後検証の failure が「負荷由来」かを機械的に決め、1 回だけ再実行するための部品。
//
// 2026-10-04、AGENTS.md と docs だけの PR #846 の着地後検証が、verify スロット 2 本 + スロット外の負荷
// (load average 48〜111、10 コア) で 2 回続けて偽の failure を出し、main-broken の枠で全マージが止まった
// (同じ sha の GitHub CI は success、負荷が下がってからの再検証も success)。1 回目は web の
// `Test timed out in 5000ms` 4 件と vitest の worker 起動の Timeout だった。
//
// 判断材料は「失敗の形」だけにする (load average の記録は使わない)。理由:
// - 失敗そのものが「時間切れ」と言っているものだけを対象にできる。負荷が高い間に出たアサーションの失敗
//   (本物の競合バグでありうる) は再実行しない。load average で決めると、高負荷の間のどんな失敗でも
//   再実行の対象になり、間欠的な本物の回帰を隠す範囲が広がる。
// - 閾値を 1 回の事故から決めなくてよい。
// - 決定的な回帰 (ハングで毎回時間切れになるものを含む) は再実行でもう一度落ちて failure になる。隠れうる
//   のは「時間切れで間欠的に落ちる」ものだけで、それは負荷に弱いテストそのもの。
// この判定 (classifyVerifyFailure) は、着地予定ツリーの verify と S3 の軽量チェックの失敗 (predicted.mjs) も使う
// (bdboard-e8jj)。そちらは自動では再実行しないので、「再実行は 1 回で打ち切る」上限を predicted-timeouts.mjs が
// 「同じ PR head につき 1 回の exit 75」で持つ。上限が無いと、決定的なハングが毎回 75 になって格下げされない。
// 迷う形 (vitest 以外のステップで落ちた・要約が無い・時間切れ以外のエラー行が 1 つでもある) は全部
// 「負荷由来ではない」に倒す。spawnSync の子が時間切れで殺されて status が null になり、それを
// `expected null to be +0` と比べて落ちる形 (事故の 2 回目) も、メッセージが時間切れと言っていないので対象外。
//
// 再実行の手順 (retryLoadInduced) もここに置く。1 回目の verify が抜けてから再実行の verify が verify スロットに
// 並ぶまでの数秒〜十数秒 (ログの退避・監査・pending の投稿・npm の起動) に、待っていた pr が先に枠を取って再実行を
// 待たせないよう、1 回目が終わった直後に予約 holder を置き (scripts/verify-slot.mjs の reserveVerifySlot)、
// 再実行の verify に BDBOARD_VERIFY_SLOT_HANDOFF で渡す。1 回目の verify.mjs が自分の holder を消してから予約を
// 置くまでの短い隙間は覆えない (そこで pr が始めると再実行はその終わりを待つ。遅れるだけで、隣では走らない)。
// 予約は再実行の verify が自分の holder を書いた後で消すが、その削除が失敗しても (Windows の EPERM 等) 幽霊枠を残さない
// ために、merge-pr も再実行の holder (retry: true、同じ since) が見えた時点で自分で消す (reservation-watch.mjs。
// 通常は残るのは poll 1 回分。merge-pr 自身の unlink も失敗するなら、消えるまで毎周消し直す)。それでも残る間は再実行が
// 戻るまでで、そこで必ず finally が消す。再実行が holder を見せないまま戻る経路と、再実行しない経路も finally で消す
// (中断で process.exit する経路は reserveVerifySlot の 'exit' フック、SIGKILL で残った予約は pid が死んでいれば
// 次の参加者が回収する)。
import { copyFileSync, readFileSync, renameSync } from 'node:fs';
import { cpus, loadavg } from 'node:os';

import { envSlotOptions, reserveVerifySlot } from '../verify-slot.mjs';
import { watchRetryHolder } from './reservation-watch.mjs';
import { audit, say } from './state.mjs';
import { pollMs } from './verify-queue.mjs';
import { postQuietly, runContractVerify, stoppedEarly } from './verify-run.mjs';

// eslint-disable-next-line no-control-regex -- ログに残った色付けを外す
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;
const NPM_BANNER = /^> \S+@\S+ \S/; // `> bdboard@0.1.2 test:server` (次の行が実際のコマンド)
const VITEST_COMMAND = /^> vitest(?:\s|$)/;
const SUMMARY_FILES = /^\s*Test Files\s/;
const SUMMARY_ERRORS = /^\s*Errors\s+\d+\s+errors?\b/;
const FAIL_LINE = /^\s*FAIL\s+\S/;
// vitest が 1 件のエラーの前に出す見出しの帯 (`⎯⎯ Unhandled Rejection ⎯⎯` 等)。次の空でない行がエラーの見出し。
// エラー名は任意 (`${error.name}: ${message}`) なので、下の ERROR_HEADLINE だけでは拾えない名前もある。
const ERROR_BANNER = /^\s*⎯+\s*(?:Unhandled (?:Error|Rejection)|Startup Error|Collect Error)\s*⎯+\s*$/;
// `Error: …` `AssertionError: …` `TypeError [ERR_X]: …` などのエラーの見出し行。
const ERROR_HEADLINE = /^\s*(?:[A-Za-z_$][\w$]*)?Error\b[^:]{0,40}:\s/;

/**
 * 時間切れの形 (vitest 4.1 の文言)。これ以外のエラー行が 1 つでもあれば負荷由来とはみなさない。
 * 見出しの先頭 (`Error: ` などのエラー名を外した直後) でだけ照合する: 途中に含むだけの行 (例えば
 * `AssertionError: expected 'Test timed out in 5000ms' to be …`) は時間切れではない。
 * `[birpc] timeout on calling "…"` は入れない: vitest 4 は worker / プール側の birpc に timeout: -1 を渡して
 * いてこのタイマー自体が張られない (docs/VERIFY.md「vitest worker RPC タイムアウト」)。出たら想定外なので
 * 再実行せずに調べる。
 */
export const TIMEOUT_SHAPES = Object.freeze([
  /^(?:Test|Hook) timed out in \d+ms\b/,
  /^\[vitest-pool\]: Timeout (?:starting|terminating) \S+ (?:runner|worker)\b/,
  /^\[vitest-pool-runner\]: Timeout waiting for worker to respond\b/,
  /^spawnSync \S+ ETIMEDOUT\b/,
]);
// 見出しの先頭の字下げとエラー名 (`Error: ` `TypeError [ERR_X]: ` 等。ERROR_HEADLINE と同じ形) を外す。
const HEADLINE_PREFIX = /^\s*(?:\w*Error\b[^:]{0,40}:\s*)?/;

const isTimeout = (line) => {
  const message = line.replace(HEADLINE_PREFIX, '');
  return TIMEOUT_SHAPES.some((shape) => shape.test(message));
};

function lastIndex(lines, test, from = 0) {
  for (let index = lines.length - 1; index >= from; index -= 1) {
    if (test(lines[index])) {
      return index;
    }
  }
  return -1;
}

/**
 * verify のログから、落ちたステップの失敗が全部時間切れの形かを決める純関数。
 * @returns {{ loadInduced: boolean, timeouts: number, reason: string }}
 */
export function classifyVerifyFailure(logText) {
  const lines = String(logText).replace(ANSI, '').split(/\r?\n/);
  // `&&` でつないだステップは落ちたところで止まるので、最後に始まったステップが落ちたステップ。
  const banner = lastIndex(lines, (line) => NPM_BANNER.test(line));
  if (banner === -1 || !VITEST_COMMAND.test(lines[banner + 1] ?? '')) {
    return { loadInduced: false, timeouts: 0, reason: `the failing step is not a vitest run (${(lines[banner + 1] ?? 'unknown').trim()})` };
  }
  const segment = lines.slice(banner);
  const summary = lastIndex(segment, (line) => SUMMARY_FILES.test(line));
  if (summary === -1 || !(segment[summary].includes('failed') || segment.some((line) => SUMMARY_ERRORS.test(line)))) {
    return { loadInduced: false, timeouts: 0, reason: 'no vitest failure summary' };
  }
  const headlines = new Set();
  segment.forEach((line, index) => {
    if (ERROR_HEADLINE.test(line)) {
      headlines.add(index);
    } else if (FAIL_LINE.test(line) || ERROR_BANNER.test(line)) {
      // FAIL 行 (同じエラーの FAIL 行はまとめて並ぶ) か見出しの帯の次の空でない行が、エラーの見出し。
      let next = index + 1;
      while (next < segment.length && (segment[next].trim() === '' || FAIL_LINE.test(segment[next]))) {
        next += 1;
      }
      if (next < segment.length) {
        headlines.add(next);
      }
    }
  });
  const other = [...headlines].map((index) => segment[index]).find((line) => !isTimeout(line));
  if (other !== undefined) {
    return { loadInduced: false, timeouts: 0, reason: `a failure that is not a timeout: ${other.trim().slice(0, 120)}` };
  }
  if (headlines.size === 0) {
    return { loadInduced: false, timeouts: 0, reason: 'no failure message found' };
  }
  return { loadInduced: true, timeouts: headlines.size, reason: `all ${headlines.size} failures are timeouts` };
}

export function readLogQuietly(logPath) {
  try {
    return readFileSync(logPath, 'utf8');
  } catch {
    return '';
  }
}

/**
 * 1 回目のログを別名で残す (再実行は同じ名前のログに書くため)。残せなければ null (呼び出し元は再実行しない)。
 * 名前に時刻を入れるのは、後の手動の verify が同じ sha でまた再実行しても上書きしないため。
 */
export function keepFirstAttemptLog(logPath, now = new Date()) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const kept = logPath.replace(/\.log$/, '') + `.first-attempt-${stamp}.log`;
  try {
    renameSync(logPath, kept);
    return kept;
  } catch {
    try {
      copyFileSync(logPath, kept);
      return kept;
    } catch {
      return null;
    }
  }
}

async function reserveQuietly(priority, queueSince) {
  try {
    return await reserveVerifySlot({ ...envSlotOptions(), priority, queueSince });
  } catch (error) {
    say(`verify スロットに再実行の予約を置けませんでした (${error.message})。予約なしで並び直します。`);
    return { path: undefined, release: () => {} };
  }
}

/**
 * 着地後検証 (ledger) の 1 回目が exit code で落ちた直後に呼ぶ。失敗が全部時間切れの形なら 1 回目のログを
 * 残して 1 回だけ再実行する。戻り値の retried は再実行の verify を起こしたなら { timeouts }、起こしていなければ
 * null。code は記録する終了コード、stopped は記録しない終わり方 ('error' | 'abandoned'、このときは code なし)。
 * attempt は runContractVerify の引数 (queue と running 以外)。
 */
export async function retryLoadInduced({ attempt, queue, code, by, firstQueuedAt }) {
  const { ctx, sha, logPath, activeChild } = attempt;
  // 並び直しでも最初に並んだ時刻を引き継ぐ (予約と再実行は 10 分で頭打ちにしない。verify-slot-queue.mjs の holdsRetryPlace)。
  const queueSince = queue.queueSince ?? firstQueuedAt;
  const reservation = await reserveQuietly(queue.priority, queueSince);
  try {
    const verdict = classifyVerifyFailure(readLogQuietly(logPath));
    const kept = verdict.loadInduced ? keepFirstAttemptLog(logPath) : null;
    if (kept === null) {
      const why = verdict.loadInduced ? `1 回目のログ ${logPath} を退避できなかったので再実行しません` : `負荷由来とは判断できないので再実行しません (${verdict.reason})`;
      say(`verify が失敗しました (exit ${code})。${why}。`);
      return { code, retried: null };
    }
    audit('landed-verify-retry', { sha, by, exit: code, timeouts: verdict.timeouts, load1: loadavg()[0].toFixed(1), cpus: cpus().length, log: kept });
    say(
      `verify が失敗しました (exit ${code}) が、失敗は ${verdict.timeouts} 件とも時間切れの形なので負荷由来とみなし、1 回だけ再実行します。`,
      `1 回目のログ: ${kept}`,
    );
    const running = `npm run verify retrying after load-induced failure (by ${by})`;
    if (!postQuietly(ctx, sha, 'pending', running)) {
      return { stopped: 'error', retried: null };
    }
    const stopWatching = watchRetryHolder({ reservation, since: queueSince, intervalMs: pollMs() });
    let again;
    try {
      again = await runContractVerify({ ...attempt, queue: { ...queue, queueSince, handoff: reservation.path }, running });
    } finally {
      stopWatching();
    }
    const retried = { timeouts: verdict.timeouts };
    const stopped = await stoppedEarly(activeChild, again, logPath);
    return stopped ? { stopped, retried } : { code: again, retried };
  } finally {
    reservation.release();
  }
}
