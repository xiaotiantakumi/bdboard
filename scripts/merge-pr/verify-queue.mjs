// bdboard-ulxa.6: merge-pr が回す verify を verify スロット (scripts/verify-slot.mjs) のどこに
// 並べるか (優先度・この PR が最初に並んだ時刻) と、結果がもう使えなくなった着地予定ツリーの
// verify を途中でやめる仕組み。
//
// 2026-09-25 の観測 (並列 7 本、PR #740 が predicted-verify を 5 回やり直し) では、main が進んで
// 使えなくなった predicted verify が最後まで走ってスロットを塞ぎ、並び直した PR が後から来た PR に
// 抜かれ続けていた。そこで (1) 着地後検証を最優先・着地予定ツリーを次・PR 前の手元 verify を最後に
// 並べ (verify-slot-queue.mjs)、(2) 並び直しても最初に並んだ時刻で順番を引き継ぎ、(3) verify の
// 途中で main が動いたら (待ち行列の中でも実行中でも) すぐやめて prepare に戻す。
// 検証する木・台帳・枠 (bd merge-slot) には触れない — 変えるのは順番と、捨てる結果の打ち切りだけ。
import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { terminateGroup } from './interrupt.mjs';
import { stateDir } from './state.mjs';

// 並んだ時刻の記録を使う上限。これより古いもの (何時間も前に諦めた PR 等) は捨てて今から並ぶ。
// verify-slot 側でも MAX_SENIORITY_MS (10 分) で頭打ちになる。
const SENIORITY_RESET_MS = 2 * 60 * 60_000;

function queueFile(root, pr) {
  return path.join(stateDir(root), `pr-${pr}-queue.json`);
}

/** この PR が最初に着地予定ツリーの verify に並んだ時刻 (ms)。記録が無ければ now を記録して返す。 */
export function queueSinceFor(root, pr, now = Date.now()) {
  try {
    const { since } = JSON.parse(readFileSync(queueFile(root, pr), 'utf8'));
    if (Number.isFinite(since) && since <= now && now - since < SENIORITY_RESET_MS) {
      return since;
    }
  } catch {
    // 無い・壊れている → 今から並ぶ
  }
  mkdirSync(stateDir(root), { recursive: true });
  writeFileSync(queueFile(root, pr), `${JSON.stringify({ pr, since: now })}\n`);
  return now;
}

/** マージされた PR の記録を消す (finish)。 */
export function forgetQueueSince(root, pr) {
  rmSync(queueFile(root, pr), { force: true });
}

/** 契約の verify に渡す環境変数 (scripts/verify-slot.mjs の envSlotOptions が読む)。 */
export function verifyEnv({ priority, queueSince }, base = process.env) {
  const env = { ...base, BDBOARD_VERIFY_PRIORITY: priority };
  delete env.BDBOARD_VERIFY_QUEUE_SINCE;
  if (queueSince !== undefined) {
    env.BDBOARD_VERIFY_QUEUE_SINCE = String(queueSince);
  }
  return env;
}

/**
 * いま remote に見えている main (context.mjs の liveMain と同じ git ls-remote) を非同期に読む。
 * verify の間のポーリング用で、同期版だと応答の遅いネットワークでイベントループ (= 中断シグナルの
 * 処理) を塞ぐため。読めなければ null。
 */
export function liveMainAsync(cwd, remote, branch, { signal, timeoutMs = 60_000 } = {}) {
  return new Promise((resolve) => {
    execFile('git', ['ls-remote', remote, `refs/heads/${branch}`], { cwd, timeout: timeoutMs, encoding: 'utf8', signal }, (error, stdout) => {
      const sha = error ? '' : String(stdout).split('\t')[0].trim();
      resolve(sha === '' ? null : sha);
    });
  });
}

function pollMs() {
  const raw = Number(process.env.BDBOARD_MERGE_POLL_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 30_000;
}

/**
 * intervalMs ごとに abandonWhen(signal) (同期でも Promise でもよい) を聞き、true なら (= main が動いて
 * 結果が使えなくなったら) 実行中の子をプロセスグループごと終了する (verify スロットの待ち行列に
 * 居る間なら列から抜けるだけ)。activeChild.abandoned に「終了し終わったら resolve する Promise」を
 * 置く。問い合わせは同時に 1 本まで。答えを待つ間に子が終わった・中断シグナル
 * (activeChild.interrupted) が来た・監視を止めた場合は何もしない。戻り値は監視を止める関数で、
 * 問い合わせ中なら signal を abort する (応答の遅い ls-remote で merge-pr の終了を待たせない)。
 */
export function watchForAbandon({ activeChild, abandonWhen, intervalMs = pollMs() }) {
  if (typeof abandonWhen !== 'function') {
    return () => {};
  }
  let stopped = false;
  let checking = false;
  const controller = new AbortController();
  const idle = (child) =>
    stopped || activeChild.interrupted || activeChild.abandoned || activeChild.current !== child ||
    child?.pid === undefined || child.exitCode !== null || child.signalCode !== null;
  const timer = setInterval(async () => {
    const child = activeChild.current;
    if (checking || idle(child)) {
      return;
    }
    checking = true;
    let moved;
    try {
      moved = (await abandonWhen(controller.signal)) === true;
    } catch {
      moved = false; // 読めないときは続ける (終わった後の refetch で判定)
    } finally {
      checking = false;
    }
    if (moved && !idle(child)) {
      activeChild.abandoned = terminateGroup(child);
    }
  }, intervalMs);
  return () => {
    stopped = true;
    clearInterval(timer);
    controller.abort();
  };
}
