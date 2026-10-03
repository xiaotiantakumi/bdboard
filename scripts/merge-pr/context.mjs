// bdboard-ulxa.1: 3 フェーズ共通の下ごしらえ (リポジトリ・契約・main の取得) と終了コード。
import { git, run } from './exec.mjs';
import { loadMainConfig, loadWorktreeConfig } from './config.mjs';
import { say } from './state.mjs';
import { refLockFailure, refLockLines } from './ref-lock.mjs';

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
  REF_LOCKED: 8, // origin/main の ref が lock されている (stale lock の疑い)。人が確認する。待っても直らないので再試行しない
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
 * git fetch <origin> <mainBranch>。bdboard-1syo: stderr を refLockFailure が文言で読むので、git に翻訳させない
 * (LC_ALL=C。classify.mjs の merge-tree と同じ)。
 */
function fetchMainBranch(cwd, mainBranch) {
  return run('git', ['fetch', '--quiet', REMOTE, mainBranch], { cwd, env: { ...process.env, LC_ALL: 'C' } });
}

// ref の lock の案内を出した lock のパス (finish の openContext と待ちループの refetchMain で同じ案内を繰り返さない)。
const reportedRefLocks = new Set();

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
  const fetched = fetchMainBranch(cwd, mainBranch);
  if (fetched.status !== 0) {
    // bdboard-1syo: ref の stale lock は待っても直らないので、75 (待って再試行) にせず人が見る終了コード 8 にする。
    // 判定は fetch の stderr と lock ファイルの現存で行う (並行する git との一瞬の競合は従来どおり 75)。
    const locked = refLockFailure(fetched.stderr, cwd);
    if (locked !== null && !allowOffline) {
      fail(
        EXIT.REF_LOCKED,
        ...refLockLines(`git fetch ${REMOTE} ${mainBranch}`, fetched.stderr, locked.lockPath),
        '消したら同じコマンドをやり直してください (prepare なら npm run merge-pr -- prepare <PR 番号>)。',
      );
    }
    if (!allowOffline) {
      fail(EXIT.RETRY, `git fetch ${REMOTE} ${mainBranch} に失敗しました: ${fetched.stderr.trim()}`);
    }
    if (locked === null) {
      say(`注意: git fetch ${REMOTE} ${mainBranch} に失敗しました (${fetched.stderr.trim()})。手元の ${REMOTE}/${mainBranch} で続けます。`);
    } else {
      reportedRefLocks.add(locked.lockPath);
      say(...refLockLines(`git fetch ${REMOTE} ${mainBranch}`, fetched.stderr, locked.lockPath), `手元の ${REMOTE}/${mainBranch} で続けます。`);
    }
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

/**
 * fetch し直した origin/main の SHA (待ちループの中で main の動きを見る)。
 *
 * 失敗は従来どおり落とさず、手元の origin/main を返す。bdboard-1syo: openContext と同じ判定で ref の stale lock
 * と分かったときだけ、同じ案内を lock のパスごとに 1 回出す。落とさない理由: finish は枠を返して着地後検証を
 * 回すことが最優先で、gate / predicted の「main が動いたか」は ls-remote の CAS (liveMain) が最終防衛線だから。
 * lock が残ったままなら、次の phase の openContext が exit 8 で止める。
 */
export function refetchMain(ctx) {
  const fetched = fetchMainBranch(ctx.cwd, ctx.config.mainBranch);
  const locked = fetched.status === 0 ? null : refLockFailure(fetched.stderr, ctx.cwd);
  if (locked !== null && !reportedRefLocks.has(locked.lockPath)) {
    reportedRefLocks.add(locked.lockPath);
    say(...refLockLines(`git fetch ${REMOTE} ${ctx.config.mainBranch}`, fetched.stderr, locked.lockPath), `merge-pr は手元の ${ctx.mainRef} のまま続けます。`);
  }
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
