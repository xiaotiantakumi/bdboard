// bdboard-2twf: SIGINT/SIGTERM を受けたとき、実行中の子プロセスをプロセスグループごと終了し、
// 呼び出し元の後始末 (git checkout を restoreTo へ戻す等) を済ませてから、シグナルに対応する
// 終了コードでプロセスを終える。scripts/verify.mjs のリーダーモードと同じキル手順 (SIGTERM →
// 猶予後 SIGKILL) を merge-pr の着地後検証・着地予定ツリーの verify にも適用する (PR #711
// レビューの見送り分)。中断せず正常に終わった経路はここを通らない — 呼び出し元は必ず
// finally で戻り値 (登録した signal ハンドラを外す関数) を呼ぶこと。
import { killProcessTree } from '../process-tree.mjs';

const INTERRUPT_SIGNALS = ['SIGINT', 'SIGTERM'];
const SIGNAL_EXIT_CODES = { SIGINT: 130, SIGTERM: 143 };

/** SIGTERM から SIGKILL までの猶予 (ms)。テストは BDBOARD_MERGE_KILL_GRACE_MS で短く上書きする。 */
function killGraceMs() {
  const raw = Number(process.env.BDBOARD_MERGE_KILL_GRACE_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 5_000;
}

/**
 * activeChild.current (runShellToLog が onSpawn で渡す実行中の子) を中断シグナルから守る。
 * 子が居れば SIGTERM → (猶予後) SIGKILL でプロセスグループごと終了し、実際に終わるのを待って
 * から onCleanup(signal) を呼んで process.exit する。子が居ない/すでに終わっていれば
 * onCleanup だけ呼ぶ (checkout を戻すだけで済むケース)。onCleanup は同期関数であること。
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
    let cleaned = false;
    const finishCleanup = () => {
      if (cleaned) {
        return;
      }
      cleaned = true;
      clearTimeout(killTimer);
      finish(signal);
    };
    killProcessTree(child.pid, 'SIGTERM');
    const killTimer = setTimeout(() => killProcessTree(child.pid, 'SIGKILL'), killGraceMs());
    child.once('close', finishCleanup);
    // 'close' が来なくても (listener を張る前に既に終わっていた等) 待ちきりにしない保険。
    setTimeout(finishCleanup, killGraceMs() + 2_000).unref();
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
