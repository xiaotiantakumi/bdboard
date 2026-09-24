// bdboard-ulxa.1: 層3 (着地後検証) — commit status 台帳の読み取りと待ち。
//
// 台帳は GitHub commit status の context `bdboard/landed-verify` (設計 §2.1、裁定 2)。
// 検証そのもの (detach checkout + verify + 投稿) は landed-verify.mjs。
import { git } from './exec.mjs';
import { getLandedStatus } from './github.mjs';
import { say } from './state.mjs';

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
