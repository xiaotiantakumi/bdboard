// bdboard-1syo: fetch の ref lock 競合を stale lock と一時競合に分け、人が直す案内を組み立てる。
//
// refs/remotes/origin/main.lock が残ると、origin/main が動くたびに git fetch が
//   error: cannot lock ref 'refs/remotes/origin/main': Unable to create '<abs>/….lock': File exists.
// で落ち続ける (エージェントの Bash タイムアウトや Ctrl-C で fetch を止めたとき、または lock を作ってから後始末に
// 登録するまでの隙間の SIGTERM で残る。bdboard-rlvz)。待っても直らないので、終了コード 75 (待って再試行)
// ではなく人が見る失敗として扱う。lock を消すのは人 — 本当に他の git が握っている可能性があるため、ここでは
// 何も消さない (このモジュールは判定と文言だけで、副作用は existsSync の読み取りのみ)。
//
// 人に回すのは、消すべきファイルを stderr が名指ししていて、それが今も残っているときだけ。`cannot lock ref` だけでは
// 判定しない — 並行する fetch が先に ref を動かしたときの `cannot lock ref '…': is at X but expected Y` (Apple Git
// 2.54 等。Git 2.51 は `incorrect old value provided`) も同じ前置きで、こちらは待てば直る一時的な失敗 (75)。
// 文言で判定するので fetch は LC_ALL=C で走らせる (context.mjs の fetchMainBranch)。翻訳されたロケールでは
// `Unable to create` が `Konnte '…' nicht erstellen` (de) のように変わる (classify.mjs の merge-tree と同じ理由)。
import { existsSync } from 'node:fs';
import path from 'node:path';

import { shellQuote } from './exec.mjs';

// lockfile.c の unable_to_lock_message (パスは絶対パス)。パスに ' が入っても切れないよう、末尾の `.lock': File exists` まで最短一致で読む。
const LOCK_EXISTS = /Unable to create '(.+?\.lock)': File exists/;

/**
 * git fetch の stderr が lock ファイルの作成失敗 (File exists) で、しかもその lock が今も残っているかを判定する。
 * @returns null (lock の作成失敗ではない / 並行する git が一瞬握っただけで lock はもう無い = 従来どおり一時的な失敗) |
 *          { lockPath } (名指しされた lock が残っている)
 */
export function refLockFailure(stderr, cwd) {
  const match = LOCK_EXISTS.exec(stderr);
  if (match === null) {
    return null;
  }
  const lockPath = path.resolve(cwd, match[1]);
  return existsSync(lockPath) ? { lockPath } : null;
}

/**
 * 利用者に出す案内の行。何も実行しない・何も消さない。fetchCommand は `git fetch origin main` のような文字列。
 * 「やり直す」行は含めない — 止まる openContext だけが足す (finish / refetchMain はそのまま続けるので、やり直しを促すと
 * 成功した gate / finish を二重に打たせうる)。
 */
export function refLockLines(fetchCommand, stderr, lockPath) {
  const check = "ps -axo pid,etime,command | grep '[g]it '";
  return [
    `${fetchCommand} が ref の lock で失敗しました: ${stderr.trim()}`,
    '一時的な競合ではなく、残ったロックファイル (stale lock) の可能性が高く、待っても自然には直りません。',
    '他の git が動いている可能性があるため、merge-pr は lock を自動では消しません。',
    `ロックファイル: ${lockPath}`,
    `他の git (fetch / push / merge-pr など) が動いていないことを確認してください: ${check}`,
    `動いていなければ消してください: rm -f ${shellQuote(lockPath)}`,
  ];
}
