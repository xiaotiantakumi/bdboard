// bdboard-1syo: fetch の ref lock 競合を stale lock と一時競合に分け、人が直す案内を組み立てる。
//
// refs/remotes/origin/main.lock が残ると、origin/main が動くたびに git fetch が
//   error: cannot lock ref 'refs/remotes/origin/main': Unable to create '<abs>/….lock': File exists.
// で落ち続ける (エージェントの Bash タイムアウトや Ctrl-C で fetch を止めたとき、または lock を作ってから後始末に
// 登録するまでの隙間の SIGTERM で残る。bdboard-rlvz)。待っても直らないので、終了コード 75 (待って再試行)
// ではなく人が見る失敗として扱う。lock を消すのは人 — 本当に他の git が握っている可能性があるため、ここでは
// 何も消さない (このモジュールは判定と文言だけで、副作用は existsSync の読み取りのみ)。
import { existsSync } from 'node:fs';
import path from 'node:path';

import { shellQuote } from './exec.mjs';

const LOCK_FAILURE = /cannot lock ref|Unable to create '[^']*\.lock'|\.lock'?: File exists/i;
const LOCK_PATH = /Unable to create '([^']+\.lock)'/;

/**
 * git fetch の stderr が ref の lock 競合で、しかも lock が今も残っているかを判定する。
 * @returns null (lock 競合ではない / 並行する git が一瞬握っただけで lock はもう無い = 従来どおり一時的な失敗) |
 *          { lockPath } (lock が残っている。パスが stderr から取れなければ null)
 */
export function refLockFailure(stderr, cwd) {
  if (!LOCK_FAILURE.test(stderr)) {
    return null;
  }
  const match = LOCK_PATH.exec(stderr);
  if (match === null) {
    return { lockPath: null };
  }
  const lockPath = path.resolve(cwd, match[1]);
  return existsSync(lockPath) ? { lockPath } : null;
}

/** 利用者に出す案内の行。何も実行しない・何も消さない。fetchCommand は `git fetch origin main` のような文字列。 */
export function refLockLines(fetchCommand, stderr, lockPath) {
  const check = "ps -axo pid,etime,command | grep '[g]it '";
  return [
    `${fetchCommand} が ref の lock で失敗しました: ${stderr.trim()}`,
    '一時的な競合ではなく、残ったロックファイル (stale lock) の可能性が高く、待っても自然には直りません。',
    '他の git が動いている可能性があるため、merge-pr は lock を自動では消しません。',
    lockPath === null ? 'ロックファイルのパスは上の stderr を確認してください。' : `ロックファイル: ${lockPath}`,
    `他の git (fetch / push / merge-pr など) が動いていないことを確認してください: ${check}`,
    `動いていなければ消してください: rm -f ${lockPath === null ? '<ロックファイル>' : shellQuote(lockPath)}`,
    '消したら同じコマンドをやり直してください (prepare なら npm run merge-pr -- prepare <PR 番号>)。',
  ];
}
