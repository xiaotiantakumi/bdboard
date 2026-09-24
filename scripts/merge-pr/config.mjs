// bdboard-ulxa.1: .claude/bdboard-harness.json の merge 節と、merge-pr が使う契約値の読み取り。
//
// merge.mode が段階の切り替えスイッチ (設計 bdboard-ulxa §5):
//   S0 = 現行手順 (枠の中で rebase / CI 待ち / 着地後検証まで行う)。merge-pr は prepare の
//        分類表示だけを行い、gate / finish は動かない
//   S1 = 枠は acquire → CAS → gh pr merge → release の一瞬だけ。着地後検証は枠の外で行い
//        commit status (statusContext) に記録する
//   S2 = S1 + main が動いていても rebase しない (bdboard-ulxa.2)。prepare が着地予定ツリー
//        (merge-tree) を作って verify し、テキスト衝突 / hot file (hotFiles) のときだけ rebase
// S3 (重なりなしの PR の軽量チェック) は後続チケット (bdboard-ulxa.3)。
//
// 方針 (どちらの契約を読むか): 手順の切り替えは「main に入った設定」で決まる。PR ブランチは
// 切った時点の設定を持っているので、ブランチ側を読むと議長が main で S1 に切り替えても
// 古いブランチだけ S0 のまま動く。そこで fetch 後の <remote>/<mainBranch> の契約を読み、
// 読めないときだけ作業ツリーの契約に落ちる。
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { run } from './exec.mjs';
import { DEFAULT_HOT_FILES, globToRegExp } from './hot-files.mjs';

export const CONTRACT_RELATIVE_PATH = '.claude/bdboard-harness.json';
export const MERGE_MODES = ['S0', 'S1', 'S2'];
/** gate / finish が動く段階 (S0 は prepare の表示だけ)。 */
export const SLOT_MODES = ['S1', 'S2'];
export const MERGE_DEFAULTS = Object.freeze({
  mode: 'S0',
  leaseMinutes: 8,
  slotWaitMinutes: 10,
  statusContext: 'bdboard/landed-verify',
  hotFiles: DEFAULT_HOT_FILES,
});

function validHotFiles(value) {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) {
    return false;
  }
  try {
    value.forEach(globToRegExp);
    return true;
  } catch {
    return false;
  }
}

const SAFE_BRANCH = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]+$/;
const SLUG = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function positiveNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/**
 * 契約 JSON (パース済み) から merge-pr の設定を作る。未知キーは無視 (契約本体と同じ前方互換)。
 * @returns {{ ok: true, config: object } | { ok: false, message: string }}
 */
export function parseMergeConfig(contract) {
  if (contract === null || typeof contract !== 'object' || Array.isArray(contract)) {
    return { ok: false, message: '契約のトップレベルがオブジェクトではありません' };
  }
  if (typeof contract.verify !== 'string' || contract.verify.trim() === '') {
    return { ok: false, message: 'verify (検証コマンド) が宣言されていません' };
  }
  const mainBranch = contract.mainBranch === undefined ? 'main' : contract.mainBranch;
  if (typeof mainBranch !== 'string' || !SAFE_BRANCH.test(mainBranch)) {
    return { ok: false, message: `mainBranch が不正です: ${JSON.stringify(contract.mainBranch)}` };
  }
  const merge = contract.merge === undefined ? {} : contract.merge;
  if (merge === null || typeof merge !== 'object' || Array.isArray(merge)) {
    return { ok: false, message: 'merge はオブジェクトである必要があります' };
  }
  const config = { ...MERGE_DEFAULTS, verify: contract.verify.trim(), mainBranch, repo: null };
  if (merge.mode !== undefined) {
    if (!MERGE_MODES.includes(merge.mode)) {
      return { ok: false, message: `merge.mode は ${MERGE_MODES.join(' / ')} のいずれかです (受領: ${JSON.stringify(merge.mode)})` };
    }
    config.mode = merge.mode;
  }
  for (const key of ['leaseMinutes', 'slotWaitMinutes']) {
    if (merge[key] !== undefined) {
      if (!positiveNumber(merge[key])) {
        return { ok: false, message: `merge.${key} は正の数である必要があります` };
      }
      config[key] = merge[key];
    }
  }
  if (merge.statusContext !== undefined) {
    if (typeof merge.statusContext !== 'string' || !/^[A-Za-z0-9._/-]+$/.test(merge.statusContext)) {
      return { ok: false, message: 'merge.statusContext は英数字と . _ / - だけの文字列です' };
    }
    config.statusContext = merge.statusContext;
  }
  if (merge.hotFiles !== undefined) {
    if (!validHotFiles(merge.hotFiles)) {
      return { ok: false, message: 'merge.hotFiles はグロブ文字列の配列です (scripts/merge-pr/hot-files.mjs の文法)' };
    }
    config.hotFiles = [...merge.hotFiles];
  }
  if (merge.repo !== undefined) {
    if (typeof merge.repo !== 'string' || !SLUG.test(merge.repo)) {
      return { ok: false, message: 'merge.repo は owner/name 形式です' };
    }
    config.repo = merge.repo;
  }
  return { ok: true, config };
}

/** origin の URL から GitHub の owner/name を取り出す。取れなければ null。 */
export function parseGitHubSlug(url) {
  const match = /github\.com[:/]+([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(url.trim());
  return match === null ? null : `${match[1]}/${match[2]}`;
}

function parseText(text, source) {
  let contract;
  try {
    contract = JSON.parse(text);
  } catch {
    return { ok: false, message: `${source} が JSON として読めません` };
  }
  const parsed = parseMergeConfig(contract);
  return parsed.ok ? { ok: true, config: { ...parsed.config, source } } : { ok: false, message: `${source}: ${parsed.message}` };
}

/** 作業ツリーの契約 (fetch 前に mainBranch を知るため) を読む。 */
export function loadWorktreeConfig(root) {
  let text;
  try {
    text = readFileSync(path.join(root, CONTRACT_RELATIVE_PATH), 'utf8');
  } catch {
    return { ok: false, message: `${CONTRACT_RELATIVE_PATH} が読めません (${root})` };
  }
  return parseText(text, `worktree:${CONTRACT_RELATIVE_PATH}`);
}

/**
 * fetch 済みの <remote>/<mainBranch> の契約を読む (手順の切り替えは main の設定が正)。
 * repo が未指定なら origin の URL から補う。
 */
export function loadMainConfig(root, remote, mainBranch) {
  const ref = `${remote}/${mainBranch}`;
  const shown = run('git', ['show', `${ref}:${CONTRACT_RELATIVE_PATH}`], { cwd: root });
  const loaded = shown.status === 0 ? parseText(shown.stdout, `${ref}:${CONTRACT_RELATIVE_PATH}`) : loadWorktreeConfig(root);
  if (!loaded.ok || loaded.config.repo !== null) {
    return loaded;
  }
  const url = run('git', ['remote', 'get-url', remote], { cwd: root });
  const slug = url.status === 0 ? parseGitHubSlug(url.stdout) : null;
  if (slug === null) {
    return { ok: false, message: `GitHub の owner/name を ${remote} の URL から決められません (merge.repo を契約に書いてください)` };
  }
  return { ok: true, config: { ...loaded.config, repo: slug } };
}
