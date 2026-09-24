// bdboard-ulxa.1: 層3 の着地後検証の本体 — PR worktree で `git checkout --detach <sha>` して
// 契約の verify を回し、結果を commit status 台帳に書く。main checkout には触らない (linked
// worktree でなければ拒否する。hook 規則 7 の pull / 再起動 / kill のどれにも当たらない)。
// bdboard-ulxa.2: S2 の着地予定ツリーの verify も同じ本体を ledger: false (台帳に書かない) で使う。
// bdboard-2twf: (1) 未追跡ファイルが verify に混ざるのを防ぐ (2) SIGINT/SIGTERM で子プロセスを
// 終了し、detach checkout を restoreTo に戻す (PR #711 レビューの見送り分。手順は interrupt.mjs)。
import { closeSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { git, gitOk, run, runShellToLog } from './exec.mjs';
import { postLandedStatus } from './github.mjs';
import { installInterruptHandler } from './interrupt.mjs';
import { readInstalledFor, say, stateDir, writeInstalledFor } from './state.mjs';

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
 * (台帳には何も書かずに) プロセスごと終了する — finish/prepare の後続処理 (ネットワーク呼び出し
 * や状態ファイルの書き換え) はそこから先に進まない。
 */
export async function runLandedVerify(ctx, sha, by, { ledger = true, logName } = {}) {
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
  const untracked = untrackedFiles(root);
  if (untracked.length > 0) {
    say(
      `作業ツリーに未追跡ファイル (.gitignore されていないもの) があるため${label}を始めません:`,
      untracked.map((file) => `  ${file}`).join('\n'),
      'コミットするか git clean/rm で消してから npm run merge-pr -- verify し直してください (混ざると検証した木と実際の木が一致しません)。',
    );
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
  const activeChild = { current: undefined };
  const removeInterruptHandler = installInterruptHandler({
    activeChild,
    onCleanup: (signal) => {
      say(`${signal} を受け取ったため${label}を中断します。子プロセスを終了して ${restoreTo} に戻します。`);
      const back = run('git', ['checkout', '--quiet', restoreTo], { cwd: root });
      if (back.status !== 0) {
        say(`元の ${restoreTo} に戻れませんでした: ${back.stderr.trim()}`);
      }
    },
  });
  let result;
  let installedAny = false;
  try {
    const onInstall = () => {
      installedAny = true;
    };
    result = await installAndVerify(ctx, { root, sha, by, originalHead, logPath, onInstall, ledger, activeChild });
  } finally {
    removeInterruptHandler();
    const back = run('git', ['checkout', '--quiet', restoreTo], { cwd: root });
    if (back.status !== 0) {
      say(`元の ${restoreTo} に戻れませんでした: ${back.stderr.trim()}`);
    }
    if (installedAny && LOCKFILES.some((lock) => lockfileChanged(root, sha, originalHead, lock.file))) {
      say(`注意: この worktree の node_modules は ${sha.slice(0, 12)} 用に入れ直しました。ブランチで作業を続けるなら npm ci し直してください。`);
    }
  }
  return { result, logPath };
}

async function installAndVerify(ctx, { root, sha, by, originalHead, logPath, onInstall, ledger, activeChild }) {
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
  let code;
  try {
    code = await runShellToLog(ctx.config.verify, {
      cwd: root,
      logFd: fd,
      heartbeatMs: ledger ? heartbeatMs(ctx) : 0,
      onHeartbeat: () => postQuietly(ctx, sha, 'pending', running),
      onSpawn: (child) => {
        activeChild.current = child;
      },
    });
  } finally {
    closeSync(fd);
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
