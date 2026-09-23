// scripts/check-file-size.mjs から切り出した CLI 本体 (baseline 設定の読み込み・引数
// 解析・main)。bdboard-sso1.58: move-only 分割。
//
// REPO_ROOT: このファイルは元の scripts/check-file-size.mjs より1段深い
// scripts/check-file-size/ に置かれているため、リポジトリルートまで '..' を1つ多く辿る
// (元は `path.dirname(...)/..`、ここでは `path.dirname(...)/../..`)。指す先(リポジトリ
// ルート)自体は変わらない。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CONFIG_RELATIVE_PATH, EXIT_FOUND, EXIT_OK, EXIT_UNAVAILABLE } from './constants.mjs';
import { buildFileRecords, listGitFiles } from './git-scan.mjs';
import { parseBaselineConfig } from './baseline-config.mjs';
import { evaluate } from './evaluate.mjs';
import { formatResult } from './format.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function loadConfig(repoRoot) {
  const configPath = path.join(repoRoot, CONFIG_RELATIVE_PATH);
  let text;
  try {
    text = fs.readFileSync(configPath, 'utf8');
  } catch (error) {
    throw new Error(`${CONFIG_RELATIVE_PATH} を読めません (${error.message})`);
  }
  return parseBaselineConfig(text);
}

export function parseCliArgs(argv) {
  let repoRoot = REPO_ROOT;
  let report = false;
  for (const arg of argv) {
    if (arg === '--report') {
      report = true;
    } else if (arg.startsWith('--repo=')) {
      repoRoot = path.resolve(arg.slice('--repo='.length));
    }
  }
  return { repoRoot, report };
}

export function main(argv) {
  const { repoRoot, report } = parseCliArgs(argv);

  let config;
  try {
    config = loadConfig(repoRoot);
  } catch (error) {
    console.error(`file-size: baseline 設定を読み込めません。\n${error.message}`);
    return EXIT_UNAVAILABLE;
  }

  let gitFiles;
  try {
    gitFiles = listGitFiles(repoRoot);
  } catch (error) {
    console.error(`file-size: git ls-files に失敗しました (${error.message.trim()})`);
    return EXIT_UNAVAILABLE;
  }

  const records = buildFileRecords(repoRoot, gitFiles);
  const evaluation = evaluate(records, config);
  console.log(formatResult(evaluation, { report }));

  const failing =
    evaluation.newOverLimit.length +
    evaluation.overOwnLimit.length +
    evaluation.shrunkBelowDefault.length +
    evaluation.missingFiles.length;
  return failing > 0 ? EXIT_FOUND : EXIT_OK;
}
