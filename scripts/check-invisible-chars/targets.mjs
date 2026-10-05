// bdboard-rqzv / bdboard-jb5x: scripts/check-invisible-chars.mjs が検査するファイルの範囲。
// 範囲は明示の一覧なので、新しい種類のファイルを足すと黙って範囲外になる。scripts/check-invisible-chars.test.mjs の
// 「this repository」が、追跡中のソース拡張子・.sh・実行ビット付き (git の mode 100755) のファイル・.github/ の yml が
// 全部対象であることを固定していて、足し忘れるとそこで落ちる。
import path from 'node:path';

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.mjs', '.js', '.cjs', '.jsx'];
// 拡張子を問わない (拡張子の無い実行ファイルのため)。
const ANY_EXTENSION = null;

// ディレクトリ (末尾 /) ごとの、検査する拡張子。どれか 1 つに当たれば対象。git ls-files の pathspec も同じ一覧から作る。
// .claude/skills/bdboard-harness/ は harness/packs/bdboard-harness/ の注入コピーだが、hook として実行されるので検査に入れる
// (違反があっても注入コピーは手で直さず、正本の harness/ 側を直す)。
const DIRECTORY_RULES = [
  { prefix: 'src/', extensions: SOURCE_EXTENSIONS },
  { prefix: 'web/src/', extensions: SOURCE_EXTENSIONS },
  { prefix: 'bin/', extensions: SOURCE_EXTENSIONS },
  { prefix: 'test/e2e/', extensions: SOURCE_EXTENSIONS },
  { prefix: 'scripts/', extensions: [...SOURCE_EXTENSIONS, '.sh'] },
  // E2E が PATH の先頭に置く bash の stub (bd / claude)。拡張子が無い。
  { prefix: 'test/e2e/fixtures/bin/', extensions: ANY_EXTENSION },
  { prefix: '.claude/skills/', extensions: ['.sh'] },
  { prefix: 'harness/', extensions: ['.sh'] },
  { prefix: '.github/', extensions: ['.yml', '.yaml'] },
];
// ルートと web/ の設定ファイルは完全一致。
const TARGET_FILES = [
  'vitest.config.ts',
  'eslint.config.mjs',
  '.dependency-cruiser.cjs',
  'web/vite.config.ts',
  'web/vitest.config.ts',
  'web/vitest.setup.ts',
];
export const GIT_PATHSPECS = [...new Set([...DIRECTORY_RULES.map(({ prefix }) => prefix.slice(0, -1)), ...TARGET_FILES])];

export function isTargetPath(relPath) {
  const normalized = relPath.replaceAll('\\', '/');
  if (TARGET_FILES.includes(normalized)) return true;
  const extension = path.posix.extname(normalized);
  return DIRECTORY_RULES.some(
    ({ prefix, extensions }) => normalized.startsWith(prefix) && (extensions === ANY_EXTENSION || extensions.includes(extension)),
  );
}

// 診断の直し方 (advice.mjs) をファイルの種類に合わせるための分類。拡張子の無いファイルは bash の stub なので shell。
export function adviceKind(relPath) {
  const extension = path.posix.extname(relPath.replaceAll('\\', '/'));
  if (extension === '.sh' || extension === '') return 'shell';
  if (extension === '.yml' || extension === '.yaml') return 'yaml';
  return 'js';
}
