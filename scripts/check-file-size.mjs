// bdboard-jygp: 1ファイルに無関係な変更理由が同居している状態を機械的に検出するガード。
//
// 行数そのものが目的ではない。目安を超える行数は「このファイルが複数の関心事を抱えている」
// ことの代理指標であり、超えたら「分割する」か「理由を書いて baseline に登録する」の
// どちらかを強制することで、巨大ファイルが無言で肥大化し続けるのを止める (詳細:
// docs/VERIFY.md の「ファイルサイズガード」節)。
//
// 対象はファイルシステム走査ではなく `git ls-files --cached --others --exclude-standard`
// (未追跡だがまだ commit していない新規ファイルも拾う。node_modules / dist 等は
// .gitignore 経由で自然に除外される)。行数の既定上限・baseline (登録済みファイルの
// 個別上限と理由) は両方とも scripts/file-size-baseline.json に置き、このスクリプトには
// 数値を埋め込まない (並行 PR で baseline だけを更新できるようにするため)。
//
// 判定 (詳しい理由は docs/VERIFY.md):
//   (a) baseline に無いファイルが既定上限超               → fail
//   (b) baseline のファイルが自分の limit 超               → fail
//   (c) baseline にあるのに既定上限以下 / ファイルが無い   → fail (baseline から外す)
//   (d) baseline の limit が現行行数より ratchetWarningThreshold 行以上大きい → warn (ラチェットを締める余地、既定 400)
//
// exit code: 0 = 問題なし / 1 = (a)(b)(c) のいずれかを検知 / 2 = 検査そのものが実行不能
// (git 呼び出し失敗・baseline JSON の形式不正など)。
//
// bdboard-sso1.58: move-only でこのファイルは入口 (再エクスポート + isMain) だけを持ち、
// 実装は scripts/check-file-size/ 配下の関心別モジュールに分割した。
import { pathToFileURL } from 'node:url';

export { CONFIG_RELATIVE_PATH, EXIT_FOUND, EXIT_OK, EXIT_UNAVAILABLE, TARGET_DIRS, TARGET_EXTENSIONS } from './check-file-size/constants.mjs';
export { isFixturePath, isTargetPath, isTestPath } from './check-file-size/classify.mjs';
export { buildFileRecords, countLines, listGitFiles } from './check-file-size/git-scan.mjs';
export { parseBaselineConfig, validateEntryShape } from './check-file-size/baseline-config.mjs';
export { evaluate } from './check-file-size/evaluate.mjs';
export { formatResult } from './check-file-size/format.mjs';
export { parseCliArgs } from './check-file-size/cli.mjs';

import { main } from './check-file-size/cli.mjs';

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  process.exitCode = main(process.argv.slice(2));
}
