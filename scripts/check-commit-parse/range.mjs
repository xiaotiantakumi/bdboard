// scripts/check-commit-parse.mjs から切り出した検査範囲の解決 (リリースタグ/manifest から
// 既定の起点を決める・--from/--to/--range を解釈する)。bdboard-sso1.63: move-only 分割。
//
// REPO_ROOT: このファイルは元の scripts/check-commit-parse.mjs より1段深い
// scripts/check-commit-parse/ に置かれているため、リポジトリルートまで '..' を1つ多く辿る
// (元は `path.dirname(...)/..`、ここでは `path.dirname(...)/../..`)。指す先(リポジトリ
// ルート)自体は変わらない。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { MANIFEST_FILE } from './constants.mjs';
import { git } from './git-log.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function readLastReleaseVersion(repoRoot = REPO_ROOT) {
  const manifestPath = path.join(repoRoot, MANIFEST_FILE);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const version = manifest['.'];
  if (typeof version !== 'string' || version.length === 0) {
    throw new Error('commit-parse: .release-please-manifest.json の "." バージョンが無効です');
  }
  return version;
}

function readManifestVersionAt(commit, repoRoot) {
  const manifest = JSON.parse(git(['show', `${commit}:${MANIFEST_FILE}`], repoRoot));
  const version = manifest['.'];
  return typeof version === 'string' && version.length > 0 ? version : undefined;
}

/**
 * 既定範囲 (`--range` / `--from` / `--to` 無し) の起点を決める (bdboard-zoxs)。
 *
 * 1. `v<manifest の版>` タグがあればそれ (`via: 'tag'`)。
 * 2. 無ければ HEAD の履歴で manifest の版をいまの版に上げたコミット (`via: 'manifest-commit'`)。
 *    release-please はリリース PR のマージコミット = manifest を上げたコミットにタグを切る
 *    (v0.1.0〜v0.1.2 はすべて一致) ので、タグが作られる前でも同じ範囲になる。
 *    - 「最後に manifest を触ったコミット」ではない。版を変えずに書き換えた後続コミット
 *      (整形・キー追加) を起点にすると範囲が狭まり、取りこぼしが黙って通るため、
 *      版が同じコミットが続く限り遡ってその最古を採る。
 *    - チェックアウト中の版を持つコミットが履歴に無ければ採らない (manifest を手元で
 *      書き換えただけ等、タグの代わりにならない状況で黙って進まない)。
 *    - shallow clone では採らない。浅い履歴の最古のコミットは manifest を「追加した」ように
 *      見えるので、起点がそこへずれて範囲が黙って縮む。
 *    - 受け入れているリスク: リリース以外の PR が manifest の版を手で上げた場合も、その
 *      コミットを起点にしてしまう。手での版上げはそもそもリリース手順の外で、起点は通知に
 *      コミットの件名ごと出るので、ログで気付ける。件名を release-please のタイトルと照合
 *      するのは、タイトルの形式が設定で変わりうるので採らない。
 * 3. どちらも使えなければ throw (呼び出し側で exit 2)。
 */
export function resolveDefaultBase(repoRoot = REPO_ROOT) {
  const version = readLastReleaseVersion(repoRoot);
  const tag = `v${version}`;
  try {
    git(['rev-parse', '-q', '--verify', `${tag}^{commit}`], repoRoot);
    return { base: tag, via: 'tag', version, tag };
  } catch {
    // タグ無し: 下のフォールバックへ
  }

  if (git(['rev-parse', '--is-shallow-repository'], repoRoot) === 'true') {
    throw new Error(
      `リリースタグ ${tag} が見つからず、shallow clone なので ${MANIFEST_FILE} の履歴からも範囲の起点を決められません ` +
        '(git fetch --unshallow --tags してから再実行してください)',
    );
  }

  let history;
  try {
    history = git(['log', '--format=%H', 'HEAD', '--', MANIFEST_FILE], repoRoot)
      .split('\n')
      .filter((line) => line.length > 0);
  } catch (error) {
    throw new Error(
      `リリースタグ ${tag} が見つからず、${MANIFEST_FILE} を更新したコミットも引けませんでした (${error.message.trim()})`,
    );
  }
  if (history.length === 0) {
    throw new Error(
      `リリースタグ ${tag} が見つからず、HEAD の履歴に ${MANIFEST_FILE} を更新したコミットもありません`,
    );
  }

  // 新しい順に見て、版がいまと同じコミットが続く限り遡る。その最古が版を上げたコミット。
  let bump;
  let latestVersion;
  for (const [index, sha] of history.entries()) {
    let committedVersion;
    try {
      committedVersion = readManifestVersionAt(sha, repoRoot);
    } catch {
      committedVersion = undefined;
    }
    if (index === 0) {
      latestVersion = committedVersion;
    }
    if (committedVersion !== version) {
      break;
    }
    bump = sha;
  }
  if (!bump) {
    throw new Error(
      `リリースタグ ${tag} が見つからず、${MANIFEST_FILE} を最後に更新したコミット ${history[0].slice(0, 7)} の版 ` +
        `(${latestVersion ?? '読めません'}) もチェックアウト中の版 ${version} と一致しないため、範囲の起点を決められません`,
    );
  }

  const subject = git(['log', '-1', '--format=%s', bump], repoRoot);
  return { base: bump, via: 'manifest-commit', version, tag, subject };
}

export function formatFallbackNotice(resolved) {
  return [
    `commit-parse: リリースタグ ${resolved.tag} が見つからないため、${MANIFEST_FILE} を ${resolved.version} に更新したコミット ` +
      `${resolved.base.slice(0, 7)} ${resolved.subject ?? ''}`.trimEnd() +
      ' を範囲の起点にします (bdboard-zoxs)。',
    'commit-parse:   リリース PR のマージ直後で release-please がまだタグを作っていないか、手元にタグを fetch していないときに起こります。' +
      `タグはこのコミットに切られるので、範囲は ${resolved.tag}..HEAD と同じです。`,
  ].join('\n');
}

export function resolveRange(argv, repoRoot = REPO_ROOT, { onNotice } = {}) {
  let fromRef;
  let toRef;
  let explicitRange;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--from') {
      fromRef = argv[++i];
    } else if (arg === '--to') {
      toRef = argv[++i];
    } else if (arg === '--range') {
      explicitRange = argv[++i];
    } else if (arg === '--repo') {
      i += 1;
    }
  }

  if (explicitRange) {
    return explicitRange;
  }
  if (fromRef && toRef) {
    return `${fromRef}..${toRef}`;
  }
  if (fromRef || toRef) {
    throw new Error('commit-parse: --from と --to は両方指定してください');
  }

  const resolved = resolveDefaultBase(repoRoot);
  if (resolved.via === 'manifest-commit') {
    onNotice?.(formatFallbackNotice(resolved));
  }
  return `${resolved.base}..HEAD`;
}
