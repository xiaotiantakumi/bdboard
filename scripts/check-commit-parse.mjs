// bdboard-84hu: release-please が @conventional-commits/parser で解析できないコミットを
// 黙って CHANGELOG から落とす。ジョブ自体は success のままなので、タグを切る前に
// v<last>..HEAD の範囲を機械的に検査する。
//
// 背景 (PR #248 / 15651d3): 本文で `(` を開いて次の行で `)` を閉じると PEG パーサが改行で
// 落ち、release-please は "commit could not be parsed" を 1 行出すだけで続行する。
// タグ以降のコミットから CHANGELOG を計算するため、取りこぼしたままタグを切るとその
// コミットは以後どのリリースにも二度と現れない。
//
// 既定範囲の起点 (bdboard-zoxs): 通常は v<manifest の版> タグ。タグが無いときは
// .release-please-manifest.json をその版に更新したコミットへフォールバックする
// (release-please はまさにそのコミットにタグを切るので、範囲は同じになる)。
// リリース PR をマージした直後の main push では、ci.yml の commit-parse と release-please.yml
// (タグ / Release を API で作る) が並行に走り、checkout 時点でタグがまだ無いことがある。
// そこで exit 2 にすると main が赤くなるので、フォールバックして通知だけ出す。
//
// exit code: 0 = 問題なし / 1 = CHANGELOG 対象の解析不能コミットあり / 2 = チェック不能
// (check-drift.mjs と同様、2 は「調べられなかった」。1 はこちらだけ検知で落とす)
//
// bdboard-sso1.63: move-only でこのファイルは入口 (再エクスポート + isMain) だけを持ち、
// 実装は scripts/check-commit-parse/ 配下の関心別モジュールに分割した。
import { pathToFileURL } from 'node:url';

export { KNOWN_UNPARSABLE } from './check-commit-parse/constants.mjs';
export {
  checkCommitMessage,
  isChangelogRelevant,
  isValidAllowlistEntry,
  findUnparsableCommits,
} from './check-commit-parse/classify.mjs';
export { escapeControlChars, caretLine, formatFindings } from './check-commit-parse/format.mjs';
export { parseCommitsFromGitLog, loadCommitsInRange } from './check-commit-parse/git-log.mjs';
export {
  readLastReleaseVersion,
  resolveDefaultBase,
  formatFallbackNotice,
  resolveRange,
} from './check-commit-parse/range.mjs';

import { main } from './check-commit-parse/cli.mjs';

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  process.exitCode = main(process.argv.slice(2));
}
