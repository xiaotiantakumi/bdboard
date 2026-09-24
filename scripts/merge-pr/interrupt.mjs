// bdboard-2twf: SIGINT/SIGTERM/SIGHUP を受けたとき、実行中の子プロセスをプロセスグループごと
// 終了し、呼び出し元の後始末 (git checkout を restoreTo へ戻す等) を済ませてから、シグナルに
// 対応する終了コードでプロセスを終える。scripts/verify.mjs のリーダーモードと同じキル手順
// (SIGTERM → 猶予後 SIGKILL) と同じ 3 シグナルを merge-pr の着地後検証・着地予定ツリーの
// verify にも適用する (PR #711 レビューの見送り分)。中断せず正常に終わった経路はここを
// 通らない — 呼び出し元は必ず finally で戻り値 (登録した signal ハンドラを外す関数) を呼ぶこと。
//
// bdboard-e8o1 (PR #722 レビューの見送り分 1): 契約の verify が `npm run verify` なら、それ自身が
// 孫プロセス (tsc/vitest ワーカー等) を自分の猶予で畳んでくれる (scripts/verify.mjs のリーダー
// モード) が、それ以外の契約にはその自己後始末が無い。直接の子 (シェル) の 'close' イベントは
// シェル自身が終わったことしか示さず、シェルより後に残る孫がまだ同じプロセスグループで生きて
// いても「後始末できた」と誤認しうる (誤認した場合、restoreBranch で作業ツリーを元のブランチへ
// 戻した直後にその孫がまだファイルへ書き込みを続けるおそれがある)。そこで POSIX では
// `kill(-pid, 0)` でプロセスグループそのものが空になったかをポーリングし、空になるまで
// SIGKILL を送り直す (「シェル→直接コマンドの 1 階層」ではなく、グループが実際に空になった
// ことで後始末の完了を判定する)。setsid 等でこのプロセスグループを抜けた孫には元々シグナルが
// 届かず (別グループなので `kill(-pid, 0)` にも映らない)、その場合このポーリングは (誤って)
// 早期に「空になった」と判定してしまう — 検知できないのはこの仕組みの既知の限界。ポーリングの
// 総上限は、それとは別に (uninterruptible sleep や EPERM で触れない子孫が残るなどして)
// SIGKILL を送り直しても空になったと確認できないまま待ち続けるケースに備えたもので、後始末
// (process.exit) 自体をハングさせないためのもの。
// win32 は元々プロセスグループの概念もシグナルも無く、killProcessTree が taskkill /T /F で
// ツリーごと一括処理する (process-tree.mjs) ので、従来どおり直接の子の 'close' を待つ。
import { killProcessTree } from '../process-tree.mjs';
import { say } from './state.mjs';

const INTERRUPT_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];
const SIGNAL_EXIT_CODES = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 };

// SIGTERM から SIGKILL までの猶予 (ms)。ctx.config.verify が (既定の) `npm run verify` なら、
// scripts/verify.mjs 自身も同じグループ宛て SIGTERM を受けて自分の猶予 (GRACE_MS=5000 + 500)
// で子孫を畳む。その前にこちらが SIGKILL してしまうと verify.mjs の後始末を横取りするので、
// それより長めに取る。テストは BDBOARD_MERGE_KILL_GRACE_MS で短く上書きする。
function killGraceMs() {
  const raw = Number(process.env.BDBOARD_MERGE_KILL_GRACE_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 8_000;
}

// SIGKILL を送ってからプロセスグループが空になったかを確かめる間隔 (ms)。
function killPollMs() {
  const raw = Number(process.env.BDBOARD_MERGE_KILL_POLL_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 200;
}

// ポーリングを諦めるまでの、SIGTERM を送ってからの全体上限。setsid 等でプロセスグループを
// 抜けた孫はそもそも届かないので待っても消えない — その場合でも後始末 (ブランチを戻す) 自体は
// ハングさせず先に進める。
function killTotalTimeoutMs() {
  return killGraceMs() + 10_000;
}

/** POSIX: プロセスグループ (pid をリーダーとする) にまだ何か居るか。ESRCH だけを「空」とみなす。 */
function groupAlive(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

/**
 * 子 (runShellToLog が起動した detached の子) をプロセスグループごと終了し、実際に終わったら
 * resolve する Promise を返す: SIGTERM → (猶予後) SIGKILL。子自身が `npm run verify` なら孫の
 * tsc/vitest ワーカーまで含めて scripts/verify.mjs 自身が畳む。
 *
 * POSIX では「終わった」の判定はプロセスグループ全体が空になったこと (`kill(-pid, 0)` が
 * ESRCH) で行い、空にならない限り SIGKILL を送り直す。win32 は taskkill /T /F が一括処理する
 * ので従来どおり直接の子の 'close' を待つ。
 * bdboard-ulxa.6: 中断シグナル (下の installInterruptHandler) と、main が動いたので着地予定
 * ツリーの verify を途中でやめる経路 (verify-queue.mjs の watchForAbandon) の両方が使う。
 */
export function terminateGroup(child) {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      terminateWin32(child, resolve);
    } else {
      terminatePosix(child, resolve);
    }
  });
}

function terminatePosix(child, done) {
  const pid = child.pid;
  const startedAt = Date.now();
  let settled = false;
  let pollTimer;
  const settle = () => {
    if (settled) {
      return;
    }
    settled = true;
    clearTimeout(pollTimer);
    done();
  };
  const poll = () => {
    if (settled) {
      return;
    }
    if (!groupAlive(pid)) {
      settle();
      return;
    }
    const elapsed = Date.now() - startedAt;
    if (elapsed >= killTotalTimeoutMs()) {
      say(`プロセスグループ ${pid} が ${Math.round(killTotalTimeoutMs() / 1000)} 秒待っても空になったと確認できません (SIGKILL が効かない子孫 (uninterruptible sleep や EPERM で触れないもの) が残っている可能性。setsid 等で別グループへ抜けた子孫はこの判定自体に映らないため、この待ちとは別に見落としうる)。後始末は続けます。`);
      settle();
      return;
    }
    if (elapsed >= killGraceMs()) {
      // 猶予を過ぎてもまだ生きている限り SIGKILL を送り直す (1 発撃って終わりにしない)。
      killProcessTree(pid, 'SIGKILL');
    }
    pollTimer = setTimeout(poll, killPollMs());
  };
  killProcessTree(pid, 'SIGTERM');
  pollTimer = setTimeout(poll, killPollMs());
}

function terminateWin32(child, done) {
  let cleaned = false;
  const finishCleanup = () => {
    if (cleaned) {
      return;
    }
    cleaned = true;
    clearTimeout(killTimer);
    done();
  };
  killProcessTree(child.pid, 'SIGTERM');
  const killTimer = setTimeout(() => killProcessTree(child.pid, 'SIGKILL'), killGraceMs());
  child.once('close', finishCleanup);
  // 'close' が来なくても (listener を張る前に既に終わっていた等) 待ちきりにしない保険。
  setTimeout(finishCleanup, killGraceMs() + 2_000).unref();
}

/**
 * activeChild.current (runShellToLog が onSpawn で渡す実行中の子) を中断シグナルから守る。
 * 子が居れば terminateGroup でプロセスグループごと終了し、実際に終わるのを待ってから
 * onCleanup(signal) を呼んで process.exit する。子が居ない/すでに終わっていれば onCleanup
 * だけ呼ぶ (checkout を戻すだけで済むケース)。onCleanup は同期関数であること。
 */
export function installInterruptHandler({ activeChild, onCleanup }) {
  let interrupting = false;
  const finish = (signal) => {
    onCleanup(signal);
    process.exit(SIGNAL_EXIT_CODES[signal] ?? 1);
  };
  const onSignal = (signal) => {
    if (interrupting) {
      return;
    }
    interrupting = true;
    const child = activeChild.current;
    if (child?.pid === undefined || child.exitCode !== null || child.signalCode !== null) {
      finish(signal);
      return;
    }
    // 呼び出し元 (landed-verify.mjs の installAndVerify) が runShellToLog の解決後に台帳へ
    // 書き込む前に見るフラグ。子の 'close' はこの後 (killProcessTree より後) にしか届かず、
    // JS は次のマクロタスク (setTimeout のポーリング) に進む前に必ずマイクロタスクを吐き出す
    // ので、そちらの continuation が先に走りうる — 中断を failure として台帳に書かせない
    // ためには、この時点 (まだ何も kill していない、同期区間) で立てておく必要がある。
    activeChild.interrupted = true;
    terminateGroup(child).then(() => finish(signal));
  };
  const handlers = new Map(INTERRUPT_SIGNALS.map((signal) => [signal, () => onSignal(signal)]));
  for (const [signal, handler] of handlers) {
    process.on(signal, handler);
  }
  return () => {
    for (const [signal, handler] of handlers) {
      process.removeListener(signal, handler);
    }
  };
}
