// bdboard-ulxa.2: S2 のクラス F — 着地予定ツリーを手元で verify する (設計 §2.3、§6 裁定 1)。
//
// merge-tree の結果の木を `git commit-tree` でコミットにし (親は PRED_BASE と PR head。rebase も
// push もしない。ref も作らない)、PR worktree で detach checkout して契約の verify を回す。検証の
// 本体は着地後検証と同じ runLandedVerify だが、このコミットは GitHub に無いので台帳 (commit status)
// には書かない。枠 (bd merge-slot) にも触らない — prepare は枠の外。
//
// bdboard-ulxa.3: S3 のクラス L は同じ着地予定コミットで、契約の verify の代わりに merge.lightCheck
// (既定 `npm run verify -- --light` = build + lint + check:boundaries) だけを回す。結果はフル verify と
// 別のフィールド (light*) と別の監査イベント (light-check) に残し、gate がクラスと記録の組み合わせで
// 見分ける — 軽量チェックの成功を「着地予定ツリーの verify の成功」として読ませない。
import { git } from './exec.mjs';
import { EXIT, fail, refetchMain, REMOTE } from './context.mjs';
import { runLandedVerify } from './landed-verify.mjs';
import { rebaseSteps } from './messages.mjs';
import { audit, removeState } from './state.mjs';
import { liveMainAsync, queueSinceFor } from './verify-queue.mjs';

// 着地予定コミットの作者。利用者の git 設定に依存させず、ログ上で見分けられるようにする。
const IDENTITY = {
  GIT_AUTHOR_NAME: 'bdboard merge-pr',
  GIT_AUTHOR_EMAIL: 'merge-pr@bdboard.invalid',
  GIT_COMMITTER_NAME: 'bdboard merge-pr',
  GIT_COMMITTER_EMAIL: 'merge-pr@bdboard.invalid',
};

// 検証の種類ごとの違い (コマンド・名前・状態ファイルに残すフィールド)。full はクラス F、light はクラス L。
const KINDS = {
  full: {
    command: (ctx) => ctx.config.verify,
    by: 'predicted',
    event: 'predicted-verify',
    logPrefix: 'predicted-verify',
    what: '着地予定ツリーの verify',
    whatWo: '着地予定ツリーの verify を',
    record: ({ tree, commit, seconds }) => ({
      predictedTree: tree,
      predictedCommit: commit,
      predictedVerifiedAt: new Date().toISOString(),
      predictedVerifySecs: seconds,
    }),
  },
  light: {
    command: (ctx) => ctx.config.lightCheck,
    by: 'light',
    event: 'light-check',
    logPrefix: 'light-check',
    what: '着地予定ツリーの軽量チェック',
    whatWo: '着地予定ツリーの軽量チェックを',
    record: ({ tree, commit, seconds, command }) => ({
      lightTree: tree,
      lightCommit: commit,
      lightCheck: command,
      lightCheckedAt: new Date().toISOString(),
      lightCheckSecs: seconds,
    }),
  },
};

export function predictedCommit(ctx, pr, { predBase, head, tree }) {
  return git(['commit-tree', '--no-gpg-sign', tree, '-p', predBase, '-p', head, '-m', `bdboard merge-pr: predicted landed tree for PR #${pr}`], {
    cwd: ctx.cwd,
    env: { ...process.env, ...IDENTITY },
  });
}

/**
 * 着地予定ツリーを verify する (kind 'light' なら軽量チェック)。success なら状態ファイルに足す
 * フィールドを返す。failure → exit 3 (rebase に格下げ) / 実行できない → exit 1 / verify 中に main が
 * 動いた → exit 75。どの失敗でも状態ファイルは消す (前回の prepare の記録で gate に進ませない)。
 *
 * bdboard-ulxa.6: verify スロットには優先度 merge で、この PR が最初に並んだ時刻を添えて並ぶ。
 * verify の間 (スロット待ちを含む) に remote の main が PRED_BASE から動いたら、その場で verify を
 * やめて exit 75 (結果は gate の CAS で必ず捨てられるので、最後まで走らせるとスロットを塞ぐだけ)。
 */
export async function verifyPredicted(ctx, pr, id, { predBase, head, tree }, { kind = 'full' } = {}) {
  const spec = KINDS[kind];
  const command = spec.command(ctx);
  const commit = predictedCommit(ctx, pr, { predBase, head, tree });
  const startedAt = Date.now();
  const verified = await runLandedVerify(ctx, commit, `${id} ${spec.by}`, {
    command,
    ledger: false,
    logName: `${spec.logPrefix}-pr${pr}-${tree.slice(0, 12)}.log`,
    retryHint: `npm run merge-pr -- prepare ${pr}`,
    priority: 'merge',
    queueSince: queueSinceFor(ctx.cwd, pr),
    abandonWhen: async (signal) => {
      const live = await liveMainAsync(ctx.cwd, REMOTE, ctx.config.mainBranch, { signal });
      return live !== null && live !== predBase; // 読めないときは続ける (終わった後の refetch で判定)
    },
  });
  const seconds = Math.round((Date.now() - startedAt) / 1000);
  const extra = kind === 'light' ? { command } : {};
  audit(spec.event, { pr, id, base: predBase, head, tree, commit, result: verified.result, secs: seconds, ...extra });
  if (verified.result === 'abandoned') {
    removeState(ctx.cwd, pr);
    fail(
      EXIT.RETRY,
      `verify の間に ${ctx.mainRef} が ${predBase.slice(0, 12)} から動いたので、${spec.whatWo}途中でやめました (結果はもう使えません)。`,
      `prepare からやり直してください: npm run merge-pr -- prepare ${pr} (verify スロットの順番は最初に並んだ時刻を引き継ぎます)`,
    );
  }
  if (verified.result === 'error') {
    removeState(ctx.cwd, pr);
    fail(EXIT.USAGE, `${spec.whatWo}実行できませんでした (上のメッセージ参照)。直してから prepare し直してください。`);
  }
  if (verified.result === 'failure') {
    removeState(ctx.cwd, pr);
    fail(
      EXIT.NEEDS_REBASE,
      `着地予定ツリー (${ctx.mainRef} ${predBase.slice(0, 12)} + PR head ${head.slice(0, 12)}) で ${kind === 'light' ? `軽量チェック (${command})` : 'verify'} が失敗しました。`,
      `main の変更との意味的衝突の可能性が高いので rebase に格下げします (ログ: ${verified.logPath})。`,
      '  既知のフレーク (bdboard-241s 等) だとログから言えるときだけ、そのまま prepare し直してよい。',
      ...rebaseSteps(ctx.mainRef, `${spec.what} failure`),
    );
  }
  if (refetchMain(ctx) !== predBase) {
    removeState(ctx.cwd, pr);
    fail(EXIT.RETRY, `verify の間に ${ctx.mainRef} が ${predBase.slice(0, 12)} から動きました。prepare からやり直してください。`);
  }
  return spec.record({ tree, commit, seconds, command });
}
