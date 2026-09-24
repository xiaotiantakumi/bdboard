// bdboard-ulxa.1: 層3 (着地後検証) — commit status 台帳の読み取り・待ち・自前の検証。
//
// 台帳は GitHub commit status の context `bdboard/landed-verify` (設計 §2.1、裁定 2)。
// 着地後検証は PR worktree で `git checkout --detach <sha>` して契約の verify を回す。main
// checkout には触らない (hook 規則 7 の pull / 再起動 / kill のどれにも当たらない)。
import { closeSync, openSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { git, gitOk, run, runShellToLog } from './exec.mjs';
import { getLandedStatus, postLandedStatus } from './github.mjs';
import { readInstalledFor, say, stateDir, writeInstalledFor } from './state.mjs';

/**
 * 台帳の 1 件 (または無し) を判定に変える純関数。
 * - success → 進んでよい / failure・error → main が壊れている (LEASE 超過でも自動では解除しない)
 * - pending か無し → 最後の動き (pending の更新時刻、無ければコミット時刻) から LEASE 以内なら
 *   待つ、超えていれば stale (= 呼び出し側が自分で検証して台帳を書く、設計 §2.2 の自己修復)
 */
export function evaluateLandedStatus({ status, commitTimeMs, nowMs, leaseMs }) {
  if (status?.state === 'success') {
    return { verdict: 'success' };
  }
  if (status?.state === 'failure' || status?.state === 'error') {
    return { verdict: 'failure', description: status.description };
  }
  const since = Math.max(commitTimeMs, status?.updatedAt ?? 0);
  const age = nowMs - since;
  return age > leaseMs ? { verdict: 'stale', ageMs: age } : { verdict: 'wait', remainingMs: leaseMs - age };
}

export function commitTimeMs(root, sha) {
  return Number(git(['show', '-s', '--format=%ct', sha], { cwd: root })) * 1000;
}

function pollMs() {
  const raw = Number(process.env.BDBOARD_MERGE_POLL_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 30_000;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * sha の台帳が success / failure / stale のどれかになるまで待つ。待っている間に main が
 * 動いたら 'moved' (CAS は必ず負けるので、待つ意味が無い)。
 */
export async function waitForLanded(ctx, sha, { mainMoved }) {
  const leaseMs = ctx.config.leaseMinutes * 60_000;
  const committed = commitTimeMs(ctx.cwd, sha);
  for (;;) {
    const decision = evaluateLandedStatus({
      status: getLandedStatus(ctx, sha),
      commitTimeMs: committed,
      nowMs: Date.now(),
      leaseMs,
    });
    if (decision.verdict !== 'wait') {
      return decision;
    }
    say(`${sha.slice(0, 8)} の着地後検証を待っています (残り最大 ${Math.ceil(decision.remainingMs / 1000)} 秒)`);
    await sleep(Math.min(pollMs(), decision.remainingMs + 50));
    if (mainMoved()) {
      return { verdict: 'moved' };
    }
  }
}

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

/**
 * 着地後検証の本体: pending を投稿 → detach checkout → (lockfile が変わっていれば npm ci) →
 * 契約の verify → success / failure を投稿 → 元のブランチ (か SHA) に戻る。
 * 返り値の result: 'success' | 'failure' | 'error' (error = 検証を実行できなかった。台帳は pending のまま)。
 */
export function runLandedVerify(ctx, sha, by) {
  const root = ctx.cwd;
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
  postLandedStatus(ctx, sha, 'pending', `npm run verify running (by ${by})`);
  const checkout = run('git', ['checkout', '--quiet', '--detach', sha], { cwd: root });
  if (checkout.status !== 0) {
    say(`git checkout --detach ${sha} に失敗しました: ${checkout.stderr.trim()}`);
    return { result: 'error' };
  }
  const logPath = path.join(stateDir(root), `landed-verify-${sha.slice(0, 12)}.log`);
  let result = 'success';
  let why = 'npm run verify passed';
  try {
    const installedFor = readInstalledFor(root) ?? originalHead;
    for (const lock of LOCKFILES) {
      if (lockfileChanged(root, installedFor, sha, lock.file)) {
        say(`${lock.file} が変わっているので npm ${lock.args.join(' ')} を実行します`);
        const installed = run('npm', lock.args, { cwd: root, stdio: ['ignore', 'inherit', 'inherit'] });
        if (installed.status !== 0) {
          result = 'failure';
          why = `npm ${lock.args.join(' ')} failed`;
          break;
        }
        writeInstalledFor(root, sha);
      }
    }
    if (result === 'success') {
      say(`${ctx.config.verify} を ${sha.slice(0, 8)} で実行します (ログ: ${logPath})`);
      const fd = openSync(logPath, 'w');
      let code;
      try {
        code = runShellToLog(ctx.config.verify, { cwd: root, logFd: fd });
      } finally {
        closeSync(fd);
      }
      if (code !== 0) {
        result = 'failure';
        why = `npm run verify failed (exit ${code})`;
        say(`verify が失敗しました (exit ${code})。ログの末尾:`, tail(logPath, 40));
      }
    }
    postLandedStatus(ctx, sha, result, `${why} (by ${by})`);
  } finally {
    const back = run('git', ['checkout', '--quiet', restoreTo], { cwd: root });
    if (back.status !== 0) {
      say(`元の ${restoreTo} に戻れませんでした: ${back.stderr.trim()}`);
    }
  }
  return { result, logPath };
}
