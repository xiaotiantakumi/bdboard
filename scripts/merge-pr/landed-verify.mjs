// bdboard-ulxa.1: 層3 の着地後検証の本体 — PR worktree で `git checkout --detach <sha>` して
// 契約の verify を回し、結果を commit status 台帳に書く。main checkout には触らない (linked
// worktree でなければ拒否する。hook 規則 7 の pull / 再起動 / kill のどれにも当たらない)。
// bdboard-ulxa.2: S2 の着地予定ツリーの verify も同じ本体を ledger: false (台帳に書かない) で使う。
// bdboard-2twf: (1) 未追跡ファイルが verify に混ざるのを防ぐ (2) SIGINT/SIGTERM で子プロセスを
// 終了し、detach checkout を restoreTo に戻す (PR #711 レビューの見送り分。手順は interrupt.mjs)。
// bdboard-e8o1 (PR #722 のレビューで見送った残り): (1)の ignore 判定を detach 先の sha のツリーで
// 行うよう順序を直し、(2)の中断メッセージに「次にやり直すコマンド」のヒントと監査ログを足した。
import { closeSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { git, gitOk, run, runShellToLog } from './exec.mjs';
import { postLandedStatus } from './github.mjs';
import { installInterruptHandler } from './interrupt.mjs';
import { audit, readInstalledFor, say, stateDir, writeInstalledFor } from './state.mjs';
import { verifyEnv, watchForAbandon } from './verify-queue.mjs';

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

function tail(file, lines) {
  try {
    return readFileSync(file, 'utf8').trimEnd().split('\n').slice(-lines).join('\n');
  } catch {
    return '';
  }
}

/** linked worktree (git worktree add で作ったもの) か。main checkout は git-dir = common-dir。 */
function isLinkedWorktree(root) {
  const dirs = run('git', ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir'], { cwd: root });
  const [gitDir, commonDir] = dirs.stdout.trim().split('\n');
  return dirs.status === 0 && gitDir !== commonDir;
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

function restoreBranch(root, restoreTo) {
  const back = run('git', ['checkout', '--quiet', restoreTo], { cwd: root });
  if (back.status !== 0) {
    say(`元の ${restoreTo} に戻れませんでした: ${back.stderr.trim()}`);
  }
}

function heartbeatMs(ctx) {
  const raw = Number(process.env.BDBOARD_MERGE_HEARTBEAT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : Math.max(10_000, (ctx.config.leaseMinutes * 60_000) / 3);
}

function postQuietly(ctx, sha, state, description) {
  try {
    postLandedStatus(ctx, sha, state, description);
    return true;
  } catch (error) {
    say(error.message);
    return false;
  }
}

/**
 * 着地後検証の本体: detach checkout → (lockfile が変わっていれば npm ci) → pending を投稿 →
 * 契約の verify (実行中は pending を定期更新) → success / failure を投稿 → 元のブランチに戻る。
 * 返り値の result: 'success' | 'failure' | 'error' (error = 検証を実行できなかった。台帳に
 * failure は書かない。pending は verify を始める直前にしか書かないので、準備段階の失敗で
 * 他の merger の LEASE を延ばさない)。ledger: false なら台帳には何も書かない (S2 の着地予定ツリー)。
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
export async function runLandedVerify(ctx, sha, by, { ledger = true, logName, retryHint, priority = 'landed', queueSince, abandonWhen } = {}) {
  const root = ctx.cwd;
  const label = ledger ? '着地後検証' : '着地予定ツリーの verify';
  if (!isLinkedWorktree(root)) {
    say(
      `${label}は PR の worktree (git worktree add で作った作業ツリー) でだけ実行します。`,
      'main checkout で detach checkout すると常時稼働サーバーの配信物 (web/dist) まで置き換わるため拒否しました。',
      ledger ? `PR の worktree に移って npm run merge-pr -- verify ${sha} を実行してください。` : 'PR の worktree に移って prepare してください。',
    );
    return { result: 'error' };
  }
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
  const checkout = run('git', ['checkout', '--quiet', '--detach', sha], { cwd: root });
  if (checkout.status !== 0) {
    say(`git checkout --detach ${sha} に失敗しました: ${checkout.stderr.trim()}`);
    return { result: 'error' };
  }
  const activeChild = { current: undefined, interrupted: false };
  const removeInterruptHandler = installInterruptHandler({
    activeChild,
    onCleanup: (signal) => {
      audit('landed-verify-interrupted', { sha, by, ledger, signal });
      say(
        `${signal} を受け取ったため${label}を中断します。子プロセスを終了して ${restoreTo} に戻します。`,
        retryHint ? `そのまま次を実行してやり直せます: ${retryHint}` : `${restoreTo} に戻したので、直してからやり直してください。`,
      );
      restoreBranch(root, restoreTo);
    },
  });
  // ハンドラは checkout 直後、未追跡ファイルの判定より前に登録する — 判定自体は速いが、ここで
  // 登録前の窓を空けると (見送り分 1・3 の opus レビュー指摘) SIGINT/SIGTERM を受けても
  // detach したまま何もできずに終わってしまう (「detach したままになりうるのは SIGKILL/crash
  // だけ」という docs/GIT-WORKFLOW.md の前提が崩れる)。
  let result;
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
          ? `コミットするか git clean/rm で消してから npm run merge-pr -- verify ${sha} し直してください (混ざると検証した木と実際の木が一致しません)。`
          : 'コミットするか git clean/rm で消してから prepare し直してください (混ざると検証した木と実際の木が一致しません)。',
      );
      result = 'error';
    } else {
      const onInstall = () => {
        installedAny = true;
      };
      const queue = { priority, queueSince, abandonWhen };
      result = await installAndVerify(ctx, { root, sha, by, originalHead, logPath, onInstall, ledger, activeChild, queue });
    }
  } finally {
    // activeChild.interrupted の間は installAndVerify がここへ戻ってこない (待つだけで
    // resolve しない) ので、この finally は「中断されなかった」経路でしか走らない。中断時の
    // 後始末 (restoreBranch・audit・process.exit) は上の onCleanup / interrupt.mjs 側が
    // 一元的に行う (opus レビュー指摘: ここで先に restoreBranch すると、プロセスグループが
    // まだ空になっていないうちにブランチを戻してしまう)。
    removeInterruptHandler();
    restoreBranch(root, restoreTo);
    if (installedAny && LOCKFILES.some((lock) => lockfileChanged(root, sha, originalHead, lock.file))) {
      say(`注意: この worktree の node_modules は ${sha.slice(0, 12)} 用に入れ直しました。ブランチで作業を続けるなら npm ci し直してください。`);
    }
  }
  return { result, logPath };
}

async function installAndVerify(ctx, { root, sha, by, originalHead, logPath, onInstall, ledger, activeChild, queue }) {
  const installedFor = readInstalledFor(root) ?? originalHead;
  for (const lock of LOCKFILES) {
    if (lockfileChanged(root, installedFor, sha, lock.file)) {
      say(`${lock.file} が変わっているので npm ${lock.args.join(' ')} を実行します`);
      onInstall();
      const installed = run('npm', lock.args, { cwd: root, stdio: ['ignore', 'inherit', 'inherit'] });
      if (installed.status !== 0) {
        // ネットワーク等の環境要因がほとんどなので main の破損 (failure) とは記録しない。
        say(`npm ${lock.args.join(' ')} が失敗しました (exit ${installed.status})。台帳には書きません。`);
        return 'error';
      }
      writeInstalledFor(root, sha);
    }
  }
  const running = `npm run verify running (by ${by})`;
  if (ledger && !postQuietly(ctx, sha, 'pending', running)) {
    return 'error';
  }
  say(`${ctx.config.verify} を ${sha.slice(0, 8)} で実行します (ログ: ${logPath})`);
  const fd = openSync(logPath, 'w');
  const stopWatch = watchForAbandon({ activeChild, abandonWhen: queue.abandonWhen });
  let code;
  try {
    code = await runShellToLog(ctx.config.verify, {
      cwd: root,
      logFd: fd,
      env: verifyEnv(queue),
      heartbeatMs: ledger ? heartbeatMs(ctx) : 0,
      onHeartbeat: () => postQuietly(ctx, sha, 'pending', running),
      onSpawn: (child) => {
        activeChild.current = child;
      },
    });
  } finally {
    stopWatch();
    closeSync(fd);
  }
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
  const result = code === 0 ? 'success' : 'failure';
  if (result === 'failure') {
    say(`verify が失敗しました (exit ${code})。ログの末尾:`, tail(logPath, 40));
  }
  if (!ledger) {
    return result;
  }
  const why = result === 'success' ? 'npm run verify passed' : `npm run verify failed (exit ${code})`;
  return postQuietly(ctx, sha, result, `${why} (by ${by})`) ? result : 'error';
}
