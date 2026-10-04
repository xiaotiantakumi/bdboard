// bdboard-xdk8: 着地後検証 (landed-verify.mjs) が契約の verify を 1 回走らせる部分と、その終わり方の判定。
// 負荷由来の失敗を 1 回だけ再実行するようになって 2 回呼ぶため、landed-verify.mjs から切り出した
// (中身は切り出す前と同じ。landed-verify.mjs を max-lines 200 に収めるためでもある)。
import { closeSync, openSync, readFileSync } from 'node:fs';

import { runShellToLog } from './exec.mjs';
import { postLandedStatus } from './github.mjs';
import { say } from './state.mjs';
import { SLOT_WAIT_TIMEOUT_EXIT_CODE } from '../verify-slot.mjs';
import { verifyEnv, watchForAbandon } from './verify-queue.mjs';

export function tail(file, lines) {
  try {
    return readFileSync(file, 'utf8').trimEnd().split('\n').slice(-lines).join('\n');
  } catch {
    return '';
  }
}

function heartbeatMs(ctx) {
  const raw = Number(process.env.BDBOARD_MERGE_HEARTBEAT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : Math.max(10_000, (ctx.config.leaseMinutes * 60_000) / 3);
}

export function postQuietly(ctx, sha, state, description) {
  try {
    postLandedStatus(ctx, sha, state, description);
    return true;
  } catch (error) {
    say(error.message);
    return false;
  }
}

/** 契約の verify を 1 回走らせて終了コードを返す (実行中は pending を定期更新、abandonWhen を監視)。 */
export async function runContractVerify({ ctx, root, sha, command = ctx.config.verify, logPath, activeChild, ledger, queue, running, onSpawn }) {
  say(`${command} を ${sha.slice(0, 8)} で実行します (ログ: ${logPath})`);
  const fd = openSync(logPath, 'w');
  const stopWatch = watchForAbandon({ activeChild, abandonWhen: queue.abandonWhen });
  try {
    return await runShellToLog(command, {
      cwd: root,
      logFd: fd,
      env: verifyEnv(queue),
      heartbeatMs: ledger ? heartbeatMs(ctx) : 0,
      onHeartbeat: () => postQuietly(ctx, sha, 'pending', running),
      onSpawn: (child) => {
        activeChild.current = child;
        // bdboard-ky9l: finish が verify のプロセスグループ (= child.pid) を状態ファイルへ残すための口。
        if (onSpawn) {
          onSpawn(child);
        }
      },
    });
  } finally {
    stopWatch();
    closeSync(fd);
  }
}

/**
 * 結果を記録しない終わり方なら、その返り値 ('abandoned' | 'error') を返す。記録してよいなら null。
 * 中断 (SIGINT/SIGTERM) では resolve しない (下のコメント)。
 */
export async function stoppedEarly(activeChild, code, logPath) {
  if (activeChild.interrupted) {
    // SIGINT/SIGTERM/SIGHUP で中断された実行。runShellToLog の 'close' は、interrupt.mjs
    // 側のプロセスグループ・ポーリング (killPollMs() 間隔、既定 200ms) より先に解決しうる
    // ため、ここに来た時点ではまだプロセスグループが空になっているとは限らない。
    // 台帳に何も書かない (中断を failure として記録しない) だけでは足りず、ここで 'error' を
    // 返して installAndVerify/runLandedVerify の finally (restoreBranch) や呼び出し元
    // (finish/verify/prepare) の後続処理 (audit・ネットワーク呼び出し・状態ファイルの書き換え
    // 等) まで進めてしまうと、interrupt.mjs 側のポーリングがまだ子孫を kill しきっていない
    // うちに作業ツリーを元のブランチへ戻すことになり、後始末が本末転倒になる
    // (bdboard-e8o1 opus レビュー指摘・再現確認済み)。中断時の後始末 (restoreBranch・
    // audit・retryHint の案内・process.exit) は interrupt.mjs の onCleanup/settle が
    // プロセスグループが実際に空になった (または諦めの上限に達した) ことを確認してから
    // 一元的に行う — ここは何も返さずに待つだけにして、その経路に譲る。settle() は必ず
    // finish() → process.exit() で終わるので、このままハングし続けることはない。
    await new Promise(() => {});
  }
  if (activeChild.abandoned) {
    // 結果がもう使えない verify を打ち切った (watchForAbandon)。プロセスグループが空になって
    // から戻る (中断シグナルと同じ理由: 先に作業ツリーを戻さない)。
    await activeChild.abandoned;
    return 'abandoned';
  }
  if (code === SLOT_WAIT_TIMEOUT_EXIT_CODE) {
    // bdboard-wj9m: verify スロットの待ちが打ち切られた (verify.mjs の予約済み終了コード)。verify は
    // 1 行も走っていないので、main が壊れたという結果ではない。台帳には pending 以外を書かず
    // (failure はもちろん、landed.mjs が main-broken と読む error も)、検証できなかった (error、再試行可) として返す。
    // bdboard-xdk8: 負荷由来の失敗の再実行がこれで終わったときも同じ (1 回目のログは残してある)。
    say(
      `verify スロットの待ちがタイムアウトしました (exit ${code})。verify は走っていないので、結果は記録しません (failure も書きません)。`,
      'スロットが空いてからやり直してください。ログの末尾:',
      tail(logPath, 10),
    );
    return 'error';
  }
  return null;
}
