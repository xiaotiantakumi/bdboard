// bdboard-ulxa.1: 3 フェーズ共通の下ごしらえ (リポジトリ・契約・main の取得) と終了コード。
import { git, run } from './exec.mjs';
import { loadMainConfig, loadWorktreeConfig } from './config.mjs';
import { say } from './state.mjs';

export const REMOTE = 'origin';

/** 終了コード。呼び出し側 (エージェント) はこの数値で次の行動を決める。 */
export const EXIT = Object.freeze({
  OK: 0,
  USAGE: 1, // 使い方・設定の誤り、想定外のエラー
  PRECONDITION: 2, // PR が OPEN でない / HEAD 不一致 / 必須チェック失敗 / S0 で gate 等
  NEEDS_REBASE: 3, // S1 のクラス R: main が動いている。rebase → push → CI → prepare
  MAIN_BROKEN: 4, // 着地後検証が failure。マージしない (設計 §3.6)
  NOT_MERGED: 5, // finish: PR はマージされていない。枠は返した
  LANDED_FAILED: 6, // finish: マージ後の着地後検証が failure (§3.6 へ)
  NOT_MERGER: 7, // gate / finish: 議長以外はマージ手順を進めない
  RETRY: 75, // EX_TEMPFAIL: CAS 負け / main が動いた / 枠が空かない / CI pending。prepare から並び直す
});

export class MergePrError extends Error {
  constructor(code, lines) {
    super(Array.isArray(lines) ? lines.join('\n') : lines);
    this.code = code;
    this.lines = Array.isArray(lines) ? lines : [lines];
  }
}

export function fail(code, ...lines) {
  throw new MergePrError(code, lines);
}

/** bd/<id> から <id>。ブランチ規約に合わないときは pr-<n>。 */
export function ticketIdFor(headRef, pr) {
  const match = /^bd\/(.+)$/.exec(headRef ?? '');
  return match === null ? `pr-${pr}` : match[1];
}

/**
 * repo root を決め、main を fetch し、main の契約を読む。
 * @returns ctx = { cwd, config, repo, statusContext, mainRef }
 */
export function openContext({ allowOffline = false } = {}) {
  const top = run('git', ['rev-parse', '--show-toplevel']);
  if (top.status !== 0) {
    fail(EXIT.USAGE, 'git リポジトリ (PR の worktree) の中で実行してください。');
  }
  const cwd = top.stdout.trim();
  const local = loadWorktreeConfig(cwd);
  if (!local.ok) {
    fail(EXIT.USAGE, local.message);
  }
  const mainBranch = local.config.mainBranch;
  const fetched = run('git', ['fetch', '--quiet', REMOTE, mainBranch], { cwd });
  if (fetched.status !== 0 && !allowOffline) {
    fail(EXIT.RETRY, `git fetch ${REMOTE} ${mainBranch} に失敗しました: ${fetched.stderr.trim()}`);
  }
  if (fetched.status !== 0) {
    say(`注意: git fetch ${REMOTE} ${mainBranch} に失敗しました (${fetched.stderr.trim()})。手元の ${REMOTE}/${mainBranch} で続けます。`);
  }
  const loaded = loadMainConfig(cwd, REMOTE, mainBranch);
  if (!loaded.ok) {
    fail(EXIT.USAGE, loaded.message);
  }
  const config = loaded.config;
  if (config.source.startsWith('worktree:')) {
    say(`注意: ${REMOTE}/${mainBranch} に契約が無いので worktree の契約 (${config.source}) で動きます。`);
  }
  return {
    cwd,
    config,
    repo: config.repo,
    statusContext: config.statusContext,
    mainRef: `${REMOTE}/${config.mainBranch}`,
  };
}

/** fetch 済みの origin/main の SHA。 */
export function fetchedMain(ctx) {
  return git(['rev-parse', `${ctx.mainRef}^{commit}`], { cwd: ctx.cwd });
}

/** fetch し直した origin/main の SHA (待ちループの中で main の動きを見る)。 */
export function refetchMain(ctx) {
  run('git', ['fetch', '--quiet', REMOTE, ctx.config.mainBranch], { cwd: ctx.cwd });
  return fetchedMain(ctx);
}

/** 層2 の CAS: いま remote に見えている main (fetch を経由しない)。 */
export function liveMain(ctx) {
  const result = run('git', ['ls-remote', REMOTE, `refs/heads/${ctx.config.mainBranch}`], { cwd: ctx.cwd });
  if (result.status !== 0) {
    return null;
  }
  const sha = result.stdout.split('\t')[0].trim();
  return sha === '' ? null : sha;
}
