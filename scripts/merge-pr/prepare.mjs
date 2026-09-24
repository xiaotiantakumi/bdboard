// bdboard-ulxa.1: フェーズ 1 (枠の外) — PR と main の状態を確かめ、どの main に対して
// マージするか (PRED_BASE) を決めて状態ファイルに残す。
//
// S1 の分類 (設計 §2.3 のうち S1 で有効なもの):
//   N = origin/main が PR head の祖先 (main 不動)。CI が見た木 = 着地する木。PRED_BASE = origin/main
//   R = main が進んでいる。rebase (か merge origin/main) → push → CI → prepare からやり直し
// F / L (着地予定ツリーの verify) は S2 以降。
import { git, gitOk } from './exec.mjs';
import { EXIT, fail, fetchedMain, ticketIdFor } from './context.mjs';
import { getPull, requiredChecks } from './github.mjs';
import { rebaseSteps } from './messages.mjs';
import { audit, removeState, say, writeState } from './state.mjs';

/** PR が OPEN・draft でない・base が main であることを確かめる (gate でも使う)。 */
export function assertOpenPull(ctx, pull, pr) {
  if (pull.merged) {
    fail(EXIT.PRECONDITION, `PR #${pr} は既にマージ済みです。`);
  }
  if (pull.state !== 'open') {
    fail(EXIT.PRECONDITION, `PR #${pr} は ${pull.state} です (open ではない)。`);
  }
  if (pull.draft) {
    fail(EXIT.PRECONDITION, `PR #${pr} は draft です。`);
  }
  if (pull.baseRef !== ctx.config.mainBranch) {
    fail(EXIT.PRECONDITION, `PR #${pr} の base は ${pull.baseRef} です (${ctx.config.mainBranch} ではない)。`);
  }
}

export function prepare(ctx, pr, { dryRun = false } = {}) {
  const pull = getPull(ctx, pr);
  assertOpenPull(ctx, pull, pr);
  const head = git(['rev-parse', 'HEAD'], { cwd: ctx.cwd });
  if (head !== pull.headSha) {
    fail(
      EXIT.PRECONDITION,
      `ローカル HEAD (${head.slice(0, 12)}) が PR #${pr} の head (${String(pull.headSha).slice(0, 12)}) と違います。`,
      'PR の worktree で実行しているか、push 済みかを確認してください。',
    );
  }
  const id = ticketIdFor(pull.headRef, pr);
  const predBase = fetchedMain(ctx);
  const cls = gitOk(['merge-base', '--is-ancestor', predBase, head], { cwd: ctx.cwd }) ? 'N' : 'R';
  const checks = cls === 'N' ? requiredChecks(ctx, pr) : { verdict: 'skipped', output: '' };
  const mode = ctx.config.mode;
  audit('prepare', { pr, id, mode, class: cls, head, base: predBase, checks: checks.verdict });
  say(
    `PR #${pr} (${id}) head=${head.slice(0, 12)} ${ctx.mainRef}=${predBase.slice(0, 12)} クラス=${cls} 必須チェック=${checks.verdict} merge.mode=${mode}`,
  );
  if (mode !== 'S1') {
    removeState(ctx.cwd, pr);
    say(
      `merge.mode は ${mode} です (${ctx.config.source})。gate / finish は動きません。`,
      '現行手順 (docs/GIT-WORKFLOW.md「Merge serialization」の S0) でマージしてください。',
    );
    return EXIT.OK;
  }
  if (cls === 'R') {
    removeState(ctx.cwd, pr);
    fail(EXIT.NEEDS_REBASE, ...rebaseSteps(ctx.mainRef));
  }
  if (checks.verdict === 'pending') {
    fail(EXIT.RETRY, '必須チェックがまだ終わっていません。gh pr checks <n> --required --watch で待ってから prepare し直してください。');
  }
  if (checks.verdict !== 'pass') {
    fail(EXIT.PRECONDITION, '必須チェックが green ではありません:', checks.output);
  }
  if (dryRun) {
    say('--dry-run: 状態ファイルは書きません。');
    return EXIT.OK;
  }
  writeState(ctx.cwd, pr, {
    pr,
    id,
    head,
    predBase,
    class: cls,
    preparedAt: new Date().toISOString(),
  });
  say(`準備完了。次: npm run merge-pr -- gate ${pr}`);
  return EXIT.OK;
}
