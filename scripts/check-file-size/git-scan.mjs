// scripts/check-file-size.mjs から切り出した git 走査 (対象ファイル一覧の取得・行数を
// 添えたレコード化) と行数カウント。bdboard-sso1.58: move-only 分割。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { TARGET_DIRS } from './constants.mjs';
import { isFixturePath, isTargetPath, isTestPath } from './classify.mjs';

/**
 * CRLF でも LF でも同じ値になる行数カウント。純関数。
 *
 * 空ファイルは 0 行。末尾に改行がある通常のテキストファイルは、その末尾の空要素を
 * 数えない (== `wc -l` と同じ挙動)。末尾に改行が無いファイルは最終行も 1 行として数える。
 */
export function countLines(text) {
  if (text.length === 0) {
    return 0;
  }
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const parts = normalized.split('\n');
  if (parts[parts.length - 1] === '') {
    parts.pop();
  }
  return parts.length;
}

function git(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trimEnd();
}

/**
 * git 管理下 (index) + 未追跡だが無視されていないファイル。対象ディレクトリだけに絞って
 * 渡すことで、無関係な巨大ディレクトリの走査コストを避ける。
 */
export function listGitFiles(repoRoot) {
  const output = git(
    [
      '-c',
      'core.quotePath=false',
      'ls-files',
      '-z',
      '--cached',
      '--others',
      '--exclude-standard',
      '--',
      ...TARGET_DIRS,
    ],
    repoRoot,
  );
  return output.split('\0').filter((entry) => entry.length > 0);
}

/**
 * 対象パスを実ファイルとして読み、行数を添えたレコードにする。fixtures 配下は除外。
 * git には載っているが作業ツリーから消えている (未 `git rm` の削除) パスは、読めない
 * ものとして黙って除く — baseline に登録されていれば missing 側で拾われる。
 */
export function buildFileRecords(repoRoot, gitFiles) {
  const records = [];
  for (const relPath of gitFiles) {
    if (!isTargetPath(relPath) || isFixturePath(relPath)) {
      continue;
    }
    let text;
    try {
      text = fs.readFileSync(path.join(repoRoot, relPath), 'utf8');
    } catch {
      continue;
    }
    records.push({ path: relPath, isTest: isTestPath(relPath), lines: countLines(text) });
  }
  return records;
}
