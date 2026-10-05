// bdboard-wea0.2: 契約の verify の後、worktree lock を SH から EX に戻してブランチを restore する部分 (worktree-hold.mjs から
// 分けた。hold の作り方と持ち主の行はそちら)。
//
// restore のための SH→EX は、拒否されると何も持たない状態に落ちる (worktree-lock.mjs の tryLock)。その隙に手動の
// verify が EX を取って持ち主の行を上書きできる (#872 再レビュー a)。そこで (1) 拒否されたらすぐ SH を取り直し、待つ間
// (200 ms) は SH を持ったままにする (隙間はヘルパー 2 回分だけになり、待っている間に来た verify は持ち主の行を見て
// 拒否する) (2) 取り直すたびに持ち主の行を読み、自分の行でなくなっていたら上書きされたと分かる: 別の merge-pr なら
// この木はそちらのものなので戻さず手放す、verify ならその verify が detach した木で走っていると 1 行知らせて待ち続ける。
// darwin では拒否された SH→EX の後も SH が残る (worktree-lock.mjs、#876 レビュー 4) ので、(1) の取り直しは helper を呼ばない。
// 最後まで EX が取れなければ戻さず、保留の行 (lsof -t と git checkout) を出す。
import { describeOwner, lsofHint, readOwner } from '../worktree-lock-owner.mjs';
import { run } from './exec.mjs';
import { say } from './state.mjs';
import { isMergePr, isOurs, lockFds, setPhase } from './worktree-hold.mjs';

const RESTORE_POLL_MS = 200;
const INTERRUPT_RESTORE_WAIT_MS = 2_000;

/** restore のための EX を待つ上限 (既定 2 分)。テストは BDBOARD_MERGE_RESTORE_WAIT_MS で短くする。 */
function restoreWaitMs() {
  const raw = Number(process.env.BDBOARD_MERGE_RESTORE_WAIT_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 2 * 60_000;
}

/**
 * restore のための EX を 1 回試す。'ok' (EX を持った) / 'lost' (別の merge-pr が持ち主になった。手放した) / 'wait'。
 * 拒否されたらすぐ SH を取り直す (上の説明 (1))。notes は上書きを 1 回だけ知らせるための印。
 */
function restoreStep(hold, notes) {
  if (hold.lock.tryLock('EX').ok) {
    const owner = readOwner(hold.path);
    if (!isOurs(owner)) {
      say(`注意: restore を待つ間に ${describeOwner(owner)} がこの worktree の lock を取っていました (detach した木で動いた可能性)。`);
    }
    return 'ok';
  }
  hold.lock.tryLock('SH');
  const owner = readOwner(hold.path);
  if (isMergePr(owner) && !isOurs(owner) && owner.phase !== 'done') {
    hold.lost = true;
    hold.lock.release();
    return 'lost';
  }
  if (!isOurs(owner) && !notes.overwritten) {
    notes.overwritten = true;
    say(`注意: 持ち主の行が上書きされました: ${describeOwner(owner)} が、detach したこの木で動いています。終わるのを待ちます。`);
  }
  return 'wait';
}

function restoreBranch(hold, restoreTo) {
  const back = run('git', ['checkout', '--quiet', restoreTo], { cwd: hold.cwd, stdio: ['ignore', 'pipe', 'pipe', ...lockFds(hold)] });
  if (back.status !== 0) {
    say(`元の ${restoreTo} に戻れませんでした: ${back.stderr.trim()}`);
  }
}

function settleRestore(hold, outcome, { restoreTo, sha }) {
  if (outcome === 'ok') {
    setPhase(hold, 'restore', { fatal: false });
    restoreBranch(hold, restoreTo);
    setPhase(hold, 'done', { fatal: false });
    return;
  }
  const why = outcome === 'lost' ? `別の merge-pr が持ち主になりました: ${describeOwner(readOwner(hold.path))}` : 'まだ誰かが lock を持っています (SH)';
  hold.lock.release();
  say(
    `restore を保留しました: 作業ツリーは ${sha.slice(0, 12)} で detach したままです (${why})。`,
    `  ${lsofHint(hold.path)} が空になったら git checkout ${restoreTo} で戻してください。`,
  );
}

/** verify の後: EX へ戻して (200 ms ごと、最大 2 分) restoreTo に戻る。取れなければ保留の行を出す。 */
export async function restoreUnderLock(hold, target) {
  if (!hold.lock.supported) {
    restoreBranch(hold, target.restoreTo);
    return;
  }
  if (hold.lost) {
    return;
  }
  const deadline = Date.now() + restoreWaitMs();
  const notes = {};
  let outcome = restoreStep(hold, notes);
  while (outcome === 'wait' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, RESTORE_POLL_MS));
    outcome = restoreStep(hold, notes);
  }
  settleRestore(hold, outcome, target);
}

/** SIGINT/SIGTERM の後始末 (同期。terminateGroup がグループの空を待った後): 最大 2 秒 EX を試して戻す。 */
export function restoreAfterInterrupt(hold, target) {
  if (!hold.lock.supported) {
    restoreBranch(hold, target.restoreTo);
    return;
  }
  if (hold.lost) {
    return;
  }
  const deadline = Date.now() + INTERRUPT_RESTORE_WAIT_MS;
  const notes = {};
  let outcome = restoreStep(hold, notes);
  while (outcome === 'wait' && Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, RESTORE_POLL_MS);
    outcome = restoreStep(hold, notes);
  }
  settleRestore(hold, outcome, target);
}
