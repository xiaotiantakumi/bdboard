// scripts/check-commit-parse.mjs から切り出した分類ロジック (パーサ実行・CHANGELOG 対象
// 判定・allowlist 照合)。bdboard-sso1.63: move-only 分割。
import { parser } from '@conventional-commits/parser';

import {
  CHANGELOG_TYPES,
  CONVENTIONAL_SUBJECT,
  KNOWN_UNPARSABLE,
  LOCATION_RE,
  MIN_ALLOWLIST_PREFIX_LEN,
} from './constants.mjs';

/**
 * release-please と同じ parser で 1 件のコミット本文を検査する。純関数。
 */
export function checkCommitMessage(message) {
  try {
    parser(message);
    return { ok: true };
  } catch (error) {
    const parserMessage = error instanceof Error ? error.message : String(error);
    const match = LOCATION_RE.exec(parserMessage);
    const line = match ? Number.parseInt(match[1], 10) : null;
    const column = match ? Number.parseInt(match[2], 10) : null;
    return { ok: false, line, column, parserMessage };
  }
}

/**
 * 件名 1 行目が CHANGELOG に載る conventional コミットか。
 */
export function isChangelogRelevant(subject) {
  const match = CONVENTIONAL_SUBJECT.exec(subject);
  if (!match) {
    return false;
  }
  if (match[4] === '!') {
    return true;
  }
  return CHANGELOG_TYPES.has(match[1]);
}

/**
 * 除外として採用できるエントリか。`sha` と `recovery` の両方が要る (bdboard-721p)。
 *
 * `recovery` を必須にしているのは fail-closed のため。手当ての手順を書かずに黙らせると、
 * このガードが検知しようとしている「CHANGELOG から黙って消える」事象を allowlist 自身が
 * 起こすことになる。書式ミスや古い文字列エントリは「除外しない」側に倒れて赤くなる。
 */
export function isValidAllowlistEntry(entry) {
  if (entry == null || typeof entry !== 'object') {
    return false;
  }
  const { sha, recovery } = entry;
  if (typeof sha !== 'string' || sha.length < MIN_ALLOWLIST_PREFIX_LEN) {
    return false;
  }
  return typeof recovery === 'string' && recovery.trim().length > 0;
}

function matchesSha(entry, sha) {
  return sha.startsWith(entry.sha) || entry.sha.startsWith(sha);
}

function findAllowlistEntry(sha, entries) {
  return entries.find((entry) => matchesSha(entry, sha));
}

/**
 * 解析不能コミットを CHANGELOG 対象 (failures) とそれ以外 (warnings) に分類する。
 */
export function findUnparsableCommits(commits, options = {}) {
  const allowlist = (options.allowlist ?? KNOWN_UNPARSABLE).filter(isValidAllowlistEntry);
  const failures = [];
  const warnings = [];
  const excluded = [];
  const matched = new Set();

  for (const commit of commits) {
    const entry = findAllowlistEntry(commit.sha, allowlist);
    if (entry) {
      matched.add(entry);
      excluded.push({ ...commit, entry });
      continue;
    }

    const parsed = checkCommitMessage(commit.message);
    if (parsed.ok) {
      continue;
    }

    const finding = { ...commit, ...parsed };
    if (isChangelogRelevant(commit.subject)) {
      failures.push(finding);
    } else {
      warnings.push(finding);
    }
  }

  // 範囲内に見つからなかったエントリ。既定範囲での実行なら「タグが切られて範囲外になった =
  // 消してよい」を意味する。PR の限定範囲では当然見つからないので、通知するかは呼び出し側の判断。
  const unused = allowlist.filter((entry) => !matched.has(entry));

  return { failures, warnings, excluded, unused };
}
