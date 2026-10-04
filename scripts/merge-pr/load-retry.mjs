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
// 迷う形 (vitest 以外のステップで落ちた・要約が無い・時間切れ以外のエラー行が 1 つでもある) は全部
// 「負荷由来ではない」に倒す。spawnSync の子が時間切れで殺されて status が null になり、それを
// `expected null to be +0` と比べて落ちる形 (事故の 2 回目) も、メッセージが時間切れと言っていないので対象外。
import { copyFileSync, readFileSync, renameSync } from 'node:fs';

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

/** 時間切れの形 (vitest 4.1 の文言)。これ以外のエラー行が 1 つでもあれば負荷由来とはみなさない。 */
export const TIMEOUT_SHAPES = Object.freeze([
  /\b(?:Test|Hook) timed out in \d+ms\b/,
  /\[vitest-pool\]: Timeout (?:starting|terminating) \S+ (?:runner|worker)\b/,
  /\[vitest-pool-runner\]: Timeout waiting for worker to respond\b/,
  /\[birpc\] timeout on calling "/,
  /\bspawnSync \S+ ETIMEDOUT\b/,
]);

const isTimeout = (line) => TIMEOUT_SHAPES.some((shape) => shape.test(line));

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
