// bdboard-ulxa.1: 層3 の着地後検証の本体 — PR worktree で `git checkout --detach <sha>` して
// 契約の verify を回し、結果を commit status 台帳に書く。main checkout には触らない (linked
// worktree でなければ拒否する。常時稼働サーバー保護 (permissions.deny / isolation) の対象に当たらない)。
// bdboard-ulxa.2: S2 の着地予定ツリーの verify も同じ本体を ledger: false (台帳に書かない) で使う。
// bdboard-2twf: (1) 未追跡ファイルが verify に混ざるのを防ぐ (2) SIGINT/SIGTERM で子プロセスを
// 終了し、detach checkout を restoreTo に戻す (PR #711 レビューの見送り分。手順は interrupt.mjs)。
// bdboard-e8o1 (PR #722 のレビューで見送った残り): (1)の ignore 判定を detach 先の sha のツリーで
// 行うよう順序を直し、(2)の中断メッセージに「次にやり直すコマンド」のヒントと監査ログを足した。
// bdboard-xdk8: 着地後検証 (台帳に書くもの) が落ち、失敗が全部時間切れの形 (負荷由来、load-retry.mjs) なら、
// 1 回目のログを別名で残して 1 回だけ再実行してから記録する。2 回目も落ちれば従来どおり failure。
// bdboard-wea0.2: 木を切り替える 2 つの操作 (detach と restore) は worktree lock の EX の下で行い、verify の間は SH に
// 降格する (worktree-hold.mjs)。npm ci と契約の verify には lock の記述を fd 3 で渡す (merge-pr が SIGKILL されても、
// その子が生きている間は lock が残る)。
import { mkdirSync } from 'node:fs';
import path from 'node:path';

import { git, gitOk, run } from './exec.mjs';
import { installInterruptHandler } from './interrupt.mjs';
import { childTimeoutLines, classifyVerifyFailure, readLogQuietly, retryLoadInduced } from './load-retry.mjs';
import { audit, readInstalledFor, say, stateDir, writeInstalledFor } from './state.mjs';
import { postQuietly, runContractVerify, stoppedEarly, tail } from './verify-run.mjs';
import { downgradeForVerify, holdWorktree, isLinkedWorktree, lockFds, setPhase } from './worktree-hold.mjs';
import { restoreAfterInterrupt, restoreUnderLock } from './worktree-restore.mjs';

const LOCKFILES = [
  { file: 'package-lock.json', args: ['ci'] },
  { file: 'web/package-lock.json', args: ['--prefix', 'web', 'ci'] },
];

function lockfileChanged(root, from, to, file) {
  if (from === to) {
    return false;
  }
  const diff = run('git', ['diff', '--quiet', from, to, '--', file], { cwd: root });
  return diff.status !== 0;
}

/**
 * ignore されていない未追跡ファイルのパス一覧 (`git status --porcelain` の `??` 行、ネストした
 * ディレクトリの中身も展開する)。verify はこの worktree のファイルをそのまま見るので、コミット
 * されていないファイルが紛れ込むと「検証した木」と「PR head / 着地予定ツリー」が一致しなくなる。
 */
function untrackedFiles(root) {
  const status = run('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: root });
  return status.stdout
    .split('\n')
    .filter((line) => line.startsWith('?? '))
    .map((line) => line.slice(3).trim())
    .filter((line) => line !== '');
}

/**
 * 着地後検証の本体: detach checkout → (lockfile が変わっていれば npm ci) → pending を投稿 →
 * 契約の verify (実行中は pending を定期更新) → success / failure を投稿 → 元のブランチに戻る。
 * 返り値の result: 'success' | 'failure' | 'error' (error = 検証を実行できなかった。台帳に
 * failure は書かない。pending は verify を始める直前にしか書かないので、準備段階の失敗で
 * 他の merger の LEASE を延ばさない)。ledger: false なら台帳には何も書かない (S2 の着地予定ツリー)。
 * bdboard-wj9m: verify が verify スロット待ちの打ち切り (scripts/verify-slot.mjs の
 * SLOT_WAIT_TIMEOUT_EXIT_CODE) で終わったときも 'error' (verify は走っていない。failure を書くと
 * main は壊れていないのに main-broken と誤記録され、枠の保持 (holdBrokenMain) にまで至る)。
 * bdboard-xdk8: ledger: true の verify が落ち、失敗が全部時間切れの形なら 1 回だけ再実行する。台帳の
 * description に「retried after load-induced failure」、監査ログに landed-verify-retry と 1 回目のログの
 * パスを残す。再実行が落ちれば failure、スロット待ちの打ち切りなら error (記録しない)。再実行したかは
 * 返り値の retried (呼び出し元が landed-verify の監査行に retried=1 を足す)。
 * bdboard-7qhq: ledger: true の verify が failure で終わったとき、最後のログにある子プロセスの時間切れ
 * (spawnSync ETIMEDOUT) の件数を返り値の etimedout に入れる (呼び出し元が監査行に etimedout=N を足す。0 件は出さない)。
 *
 * bdboard-2twf: 未追跡ファイルがあれば (ignore 済みを除く) verify を始めずに 'error' を返す。
 * verify 実行中に SIGINT/SIGTERM を受けたら、子プロセスを終了して restoreTo に戻ってから
 * (台帳には何も書かずに) プロセスごと終了する — 呼び出し元 (finish/predicted/verify いずれの
 * コマンドから来ても) の後続処理 (ネットワーク呼び出しや状態ファイルの書き換え) はそこから先に
 * 進まない。
 *
 * bdboard-e8o1 (PR #722 レビューの見送り分 2): 未追跡ファイルの ignore 判定は detach checkout の
 * 「後」に行う — 判定に使う .gitignore は、これから verify する sha のツリーのものであるべきで
 * (S2 の着地予定ツリーや、main が進んだ後の着地コミットでは、まだ detach していない現在の
 * ブランチの .gitignore と内容が違いうる)、checkout 前のままだと違う木の .gitignore で判定して
 * しまう。ハンドラの登録も checkout 直後・この判定より前に動かした (登録前の窓で
 * SIGINT/SIGTERM を受けると detach したまま何もできず終わってしまうため)。retryHint は
 * 中断時の案内 (見送り分 3) に使う「次にやり直すコマンド」の文字列。
 *
 * bdboard-ulxa.3: command は回す検証コマンド (既定は契約の verify。S3 のクラス L は merge.lightCheck を渡す)。
 *
 * bdboard-ulxa.6: priority / queueSince は verify スロットの並び順 (verify-queue.mjs)。既定の
 * 'landed' は着地後検証 (finish・gate の自己修復・手動 verify)。abandonWhen を渡すと verify の
 * 間それを定期的に聞き、true になったら子を終了して result 'abandoned' を返す (台帳には書かない。
 * 着地予定ツリーの verify が main の前進で使えなくなったときだけ使う)。
 *
 * 中断された実行 (activeChild.interrupted) は 'error' を返して呼び出し元へ制御を戻すのではなく、
 * installAndVerify 内で resolve しない Promise を await し続ける (opus レビューで見つかった
 * 退行の修正: 台帳に書かないだけでは不十分で、finally の restoreBranch や呼び出し元の後続処理が
 * interrupt.mjs 側のプロセスグループ・ポーリングより先に走ってしまい、後始末が完了する前に
 * ブランチを戻すおそれがあった)。中断時の後始末は interrupt.mjs の onCleanup/settle が
 * プロセスグループが実際に空になったことを確認してから一元的に行い、最後に process.exit する。
 */
export async function runLandedVerify(
  ctx,
  sha,
  by,
  { ledger = true, logName, retryHint, priority = 'landed', queueSince, abandonWhen, command = ctx.config.verify } = {},
) {
  const root = ctx.cwd;
  const label = ledger ? '着地後検証' : '着地予定ツリーの verify';
  if (!isLinkedWorktree(root)) {
    say(
      `${label}は PR の worktree (git worktree add で作った作業ツリー) でだけ実行します。`,
      'main checkout で detach checkout すると常時稼働サーバーの配信物 (web/dist) まで置き換わるため拒否しました。',
      ledger ? `PR の worktree に移って BDBOARD_MERGER=chair npm run merge-pr -- verify ${sha} を実行してください。` : 'PR の worktree に移って prepare してください。',
    );
    return { result: 'error' };
  }
  const hold = holdWorktree(ctx); // EX|NB (finish・prepare は入口で取り済み)。塞がっていれば 75
  if (git(['status', '--porcelain', '--untracked-files=no'], { cwd: root }) !== '') {
    say(`作業ツリーに未コミットの変更があるため${label}を始められません (detach checkout できない)。`);
    return { result: 'error' };
  }
  if (!gitOk(['cat-file', '-e', `${sha}^{commit}`], { cwd: root })) {
    say(`${sha} がローカルにありません (git fetch できていない)。`);
    return { result: 'error' };
  }
  // 状態ファイルより先にログを書くことがある (S2 の prepare、手動の verify) ので置き場を作っておく。
  mkdirSync(stateDir(root), { recursive: true });
  const logPath = path.join(stateDir(root), logName ?? `landed-verify-${sha.slice(0, 12)}.log`);
  const branch = run('git', ['symbolic-ref', '-q', '--short', 'HEAD'], { cwd: root });
  const originalHead = git(['rev-parse', 'HEAD'], { cwd: root });
  const restoreTo = branch.status === 0 ? branch.stdout.trim() : originalHead;
  setPhase(hold, 'checkout'); // detach の前に持ち主の行 (書けなければ致命的)
  // lock の記述を渡す: checkout の途中で merge-pr が SIGKILL されても、書き終えるまで lock が残る (#876 レビュー N2)。
  const checkout = run('git', ['checkout', '--quiet', '--detach', sha], { cwd: root, stdio: ['ignore', 'pipe', 'pipe', ...lockFds(hold)] });
  if (checkout.status !== 0) {
    setPhase(hold, 'done', { fatal: false });
    say(`git checkout --detach ${sha} に失敗しました: ${checkout.stderr.trim()}`);
    return { result: 'error' };
  }
  const target = { restoreTo, sha };
  const activeChild = { current: undefined, interrupted: false };
  const removeInterruptHandler = installInterruptHandler({
    activeChild,
    onCleanup: (signal) => {
      audit('landed-verify-interrupted', { sha, by, ledger, signal });
      say(
        `${signal} を受け取ったため${label}を中断します。子プロセスを終了して ${restoreTo} に戻します。`,
        retryHint ? `そのまま次を実行してやり直せます: ${retryHint}` : `${restoreTo} に戻したので、直してからやり直してください。`,
      );
      restoreAfterInterrupt(hold, target); // グループが空になった後。EX へ戻せなければ保留の行
    },
  });
  // ハンドラは checkout 直後、未追跡ファイルの判定より前に登録する — 判定自体は速いが、ここで
  // 登録前の窓を空けると (見送り分 1・3 の opus レビュー指摘) SIGINT/SIGTERM を受けても
  // detach したまま何もできずに終わってしまう (「detach したままになりうるのは SIGKILL/crash
  // だけ」という docs/GIT-WORKFLOW.md の前提が崩れる)。
  let result;
  let retried = false;
  let etimedout = 0;
  let installedAny = false;
  try {
    // detach した後 (= sha のツリーの .gitignore) で判定する。checkout 前のままだと違う木の
    // .gitignore で ignore 判定してしまう (見送り分 2)。
    const untracked = untrackedFiles(root);
    if (untracked.length > 0) {
      const shown = untracked.slice(0, 20);
      const more = untracked.length > shown.length ? `\n  ...ほか ${untracked.length - shown.length} 件` : '';
      say(
        `作業ツリーに未追跡ファイル (${sha.slice(0, 12)} の .gitignore で ignore されていないもの) が ${untracked.length} 件あるため${label}を始めません:`,
        shown.map((file) => `  ${file}`).join('\n') + more,
        ledger
          ? `コミットするか git clean/rm で消してから BDBOARD_MERGER=chair npm run merge-pr -- verify ${sha} し直してください (混ざると検証した木と実際の木が一致しません)。`
          : 'コミットするか git clean/rm で消してから prepare し直してください (混ざると検証した木と実際の木が一致しません)。',
      );
      result = 'error';
    } else {
      const onInstall = () => {
        installedAny = true;
      };
      const queue = { priority, queueSince, abandonWhen };
      downgradeForVerify(hold); // 持ち主の行 (phase verify) を書いてから SH へ。拒否なら 75 で、木は戻さない
      ({ result, retried, etimedout } = await installAndVerify(ctx, { root, sha, by, command, originalHead, logPath, onInstall, ledger, activeChild, queue, hold }));
    }
  } finally {
    // activeChild.interrupted の間は installAndVerify がここへ戻ってこない (待つだけで
    // resolve しない) ので、この finally は「中断されなかった」経路でしか走らない。中断時の
    // 後始末 (restore・audit・process.exit) は上の onCleanup / interrupt.mjs 側が
    // 一元的に行う (opus レビュー指摘: ここで先に restore すると、プロセスグループが
    // まだ空になっていないうちにブランチを戻してしまう)。restore の EX 待ち (最大 2 分) の間も
    // 中断ハンドラは外さない (外すと SIGINT で detach したまま終わる)。
    await restoreUnderLock(hold, target);
    removeInterruptHandler();
    if (installedAny && LOCKFILES.some((lock) => lockfileChanged(root, sha, originalHead, lock.file))) {
      say(`注意: この worktree の node_modules は ${sha.slice(0, 12)} 用に入れ直しました。ブランチで作業を続けるなら npm ci し直してください。`);
    }
  }
  return { result, logPath, retried: retried === true, etimedout: etimedout ?? 0 };
}

async function installAndVerify(ctx, { root, sha, by, command, originalHead, logPath, onInstall, ledger, activeChild, queue, hold }) {
  const installedFor = readInstalledFor(root) ?? originalHead;
  for (const lock of LOCKFILES) {
    if (lockfileChanged(root, installedFor, sha, lock.file)) {
      say(`${lock.file} が変わっているので npm ${lock.args.join(' ')} を実行します`);
      onInstall();
      // lock の記述を fd 3 で渡す: merge-pr がここで SIGKILL されても、npm ci が終わるまで lock は残る (設計の症状 4)。
      const installed = run('npm', lock.args, { cwd: root, stdio: ['ignore', 'inherit', 'inherit', ...lockFds(hold)] });
      if (installed.status !== 0) {
        // ネットワーク等の環境要因がほとんどなので main の破損 (failure) とは記録しない。
        say(`npm ${lock.args.join(' ')} が失敗しました (exit ${installed.status})。台帳には書きません。`);
        return { result: 'error' };
      }
      writeInstalledFor(root, sha);
    }
  }
  const running = `npm run verify running (by ${by})`;
  if (ledger && !postQuietly(ctx, sha, 'pending', running)) {
    return { result: 'error' };
  }
  // hold: 契約の verify は lock を SH で持っている間だけ走らせる (再実行の前にも確かめる。verify-run.mjs)。
  const attempt = { ctx, root, sha, command, logPath, activeChild, ledger, hold };
  const firstQueuedAt = Date.now();
  let code = await runContractVerify({ ...attempt, queue, running });
  const stopped = await stoppedEarly(activeChild, code, logPath);
  if (stopped) {
    return { result: stopped };
  }
  let retried = null;
  if (code !== 0 && ledger) {
    // bdboard-xdk8: 失敗が全部時間切れの形 (負荷由来) なら 1 回だけ再実行してから記録する (load-retry.mjs)。
    const again = await retryLoadInduced({ attempt, queue, code, by, firstQueuedAt });
    retried = again.retried;
    if (again.stopped) {
      return { result: again.stopped, retried: retried !== null };
    }
    code = again.code;
  }
  const result = code === 0 ? 'success' : 'failure';
  // bdboard-7qhq: 台帳に書く着地後検証の failure は、最後のログ (再実行したなら 2 回目) に子プロセスの時間切れ (ETIMEDOUT)
  // が何件あるかを見出しとして出し、呼び出し元の監査行 (landed-verify) にも残す。着地予定ツリーの verify は
  // predicted.mjs が自分の分類 (judgePredictedFailure) で同じ件数を出すので、ここでは読まない。
  const etimedout = result === 'failure' && ledger ? classifyVerifyFailure(readLogQuietly(logPath)).etimedout : 0;
  if (result === 'failure') {
    say(`verify が失敗しました (exit ${code})。`, ...childTimeoutLines(etimedout), 'ログの末尾:', tail(logPath, 40));
  }
  if (!ledger) {
    return { result };
  }
  const why = result === 'success' ? 'npm run verify passed' : `npm run verify failed (exit ${code})`;
  const note = retried === null ? '' : ` (retried after load-induced failure: ${retried.timeouts} timeouts)`;
  return { result: postQuietly(ctx, sha, result, `${why}${note} (by ${by})`) ? result : 'error', retried: retried !== null, etimedout };
}
