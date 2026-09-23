// scripts/check-commit-parse.mjs から切り出した CLI 本体 (引数解析・main)。
// bdboard-sso1.63: move-only 分割。
//
// REPO_ROOT: このファイルは元の scripts/check-commit-parse.mjs より1段深い
// scripts/check-commit-parse/ に置かれているため、リポジトリルートまで '..' を1つ多く辿る
// (元は `path.dirname(...)/..`、ここでは `path.dirname(...)/../..`)。指す先(リポジトリ
// ルート)自体は変わらない。main は元ファイルでは非公開関数だったが、分割によりモジュール
// 境界を越えて入口ファイルから呼ばれるため export した (呼び出し方・挙動は変えていない)。
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { EXIT_FOUND, EXIT_OK, EXIT_UNAVAILABLE, EXPLICIT_RANGE_FLAGS } from './constants.mjs';
import { findUnparsableCommits } from './classify.mjs';
import { formatFindings } from './format.mjs';
import { loadCommitsInRange } from './git-log.mjs';
import { resolveRange } from './range.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function parseCliArgs(argv) {
  let repoRoot = REPO_ROOT;
  const rangeArgv = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--repo') {
      repoRoot = path.resolve(argv[++i]);
    } else {
      rangeArgv.push(arg);
    }
  }

  return { repoRoot, rangeArgv };
}

export function main(argv) {
  const { repoRoot, rangeArgv } = parseCliArgs(argv);

  let range;
  try {
    // フォールバック時の通知は失敗ではないので stdout に出す (bdboard-zoxs)。
    range = resolveRange(rangeArgv, repoRoot, { onNotice: (notice) => console.log(notice) });
  } catch (error) {
    console.error(`commit-parse: ${error.message.trim()}`);
    return EXIT_UNAVAILABLE;
  }

  let commits;
  try {
    commits = loadCommitsInRange(range, repoRoot);
  } catch (error) {
    console.error(`commit-parse: git log に失敗しました (${error.message.trim()})`);
    return EXIT_UNAVAILABLE;
  }

  // 範囲を明示されたとき (PR の base..head) は allowlist の未使用エントリを通知しない。
  // その範囲に居ないのは当たり前で、毎PRに「消してよい」と出すのはノイズにしかならない。
  const isDefaultRange = !rangeArgv.some((arg) => EXPLICIT_RANGE_FLAGS.has(arg));

  const result = findUnparsableCommits(commits);
  console.log(
    formatFindings(result, { range, commitCount: commits.length, reportUnused: isDefaultRange }),
  );

  if (result.failures.length > 0) {
    return EXIT_FOUND;
  }
  return EXIT_OK;
}
