// bdboard-ulxa.1: 層3 の着地後検証の本体 — PR worktree で `git checkout --detach <sha>` して
// 契約の verify を回し、結果を commit status 台帳に書く。main checkout には触らない (linked
// worktree でなければ拒否する。hook 規則 7 の pull / 再起動 / kill のどれにも当たらない)。
import { closeSync, openSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { git, gitOk, run, runShellToLog } from './exec.mjs';
import { postLandedStatus } from './github.mjs';
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
 * 他の merger の LEASE を延ばさない)。
 */
export async function runLandedVerify(ctx, sha, by) {
  const root = ctx.cwd;
  if (!isLinkedWorktree(root)) {
    say(
      '着地後検証は PR の worktree (git worktree add で作った作業ツリー) でだけ実行します。',
      'main checkout で detach checkout すると常時稼働サーバーの配信物 (web/dist) まで置き換わるため拒否しました。',
      `PR の worktree に移って npm run merge-pr -- verify ${sha} を実行してください。`,
    );
    return { result: 'error' };
  }
  if (git(['status', '--porcelain', '--untracked-files=no'], { cwd: root }) !== '') {
    say('作業ツリーに未コミットの変更があるため着地後検証を始められません (detach checkout できない)。');
    return { result: 'error' };
  }
  if (!gitOk(['cat-file', '-e', `${sha}^{commit}`], { cwd: root })) {
    say(`${sha} がローカルにありません (git fetch できていない)。`);
    return { result: 'error' };
  }
  const branch = run('git', ['symbolic-ref', '-q', '--short', 'HEAD'], { cwd: root });
  const originalHead = git(['rev-parse', 'HEAD'], { cwd: root });
  const restoreTo = branch.status === 0 ? branch.stdout.trim() : originalHead;
  const checkout = run('git', ['checkout', '--quiet', '--detach', sha], { cwd: root });
  if (checkout.status !== 0) {
    say(`git checkout --detach ${sha} に失敗しました: ${checkout.stderr.trim()}`);
    return { result: 'error' };
  }
  const logPath = path.join(stateDir(root), `landed-verify-${sha.slice(0, 12)}.log`);
  let result;
  let installedAny = false;
  try {
    const onInstall = () => {
      installedAny = true;
    };
    result = await installAndVerify(ctx, { root, sha, by, originalHead, logPath, onInstall });
  } finally {
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

async function installAndVerify(ctx, { root, sha, by, originalHead, logPath, onInstall }) {
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
  if (!postQuietly(ctx, sha, 'pending', running)) {
    return 'error';
  }
  say(`${ctx.config.verify} を ${sha.slice(0, 8)} で実行します (ログ: ${logPath})`);
  const fd = openSync(logPath, 'w');
  let code;
  try {
    code = await runShellToLog(ctx.config.verify, {
      cwd: root,
      logFd: fd,
      heartbeatMs: heartbeatMs(ctx),
      onHeartbeat: () => postQuietly(ctx, sha, 'pending', running),
    });
  } finally {
    closeSync(fd);
  }
  const result = code === 0 ? 'success' : 'failure';
  if (result === 'failure') {
    say(`verify が失敗しました (exit ${code})。ログの末尾:`, tail(logPath, 40));
  }
  const why = result === 'success' ? 'npm run verify passed' : `npm run verify failed (exit ${code})`;
  return postQuietly(ctx, sha, result, `${why} (by ${by})`) ? result : 'error';
}
