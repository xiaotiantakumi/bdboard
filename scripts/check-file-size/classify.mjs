// scripts/check-file-size.mjs から切り出したパス分類 (対象パス判定・テストファイル判定・
// fixtures 判定)。bdboard-sso1.58: move-only 分割。
import { TARGET_DIRS, TARGET_EXTENSIONS } from './constants.mjs';

const TEST_PATTERN = /\.(test|spec)\.[^./]+$/;
const FIXTURE_PATTERN = /(^|\/)fixtures(\/|$)/;

// bdboard-sso1.8: src/ web/src/ scripts/ の .ts/.tsx/.mjs/.js は eslint.config.mjs の
// max-lines に一本化した (ESLint が実際に lint する拡張子)。この3ディレクトリではそれらの
// 拡張子を対象から除外し、ESLint が見ない拡張子 (web/src/index.css 等) だけを引き続き
// ここで見る。harness/ (ESLint の ignores 対象) と test/ (ESLint の lint 対象外、
// test/e2e/*.ts など) は二重管理の対象にならないため、従来どおり全拡張子を見る。
const ESLINT_COVERED_DIRS = new Set(['src', 'web/src', 'scripts']);
const ESLINT_COVERED_EXTENSIONS = ['.tsx', '.ts', '.mjs', '.js'];

/**
 * 対象ディレクトリ配下 かつ 対象拡張子 か (fixtures 判定はここに含めない)。
 * ESLint が lint する3ディレクトリ (src/ web/src/ scripts/) では、ESLint が実際に見る
 * 拡張子 (.ts/.tsx/.mjs/.js) をここでは対象外にする (二重管理の防止)。
 */
export function isTargetPath(relPath) {
  const matchedDir = TARGET_DIRS.find(
    (dir) => relPath === dir || relPath.startsWith(`${dir}/`),
  );
  if (!matchedDir) {
    return false;
  }
  if (!TARGET_EXTENSIONS.some((ext) => relPath.endsWith(ext))) {
    return false;
  }
  if (
    ESLINT_COVERED_DIRS.has(matchedDir) &&
    ESLINT_COVERED_EXTENSIONS.some((ext) => relPath.endsWith(ext))
  ) {
    return false;
  }
  return true;
}

export function isTestPath(relPath) {
  return TEST_PATTERN.test(relPath.slice(relPath.lastIndexOf('/') + 1));
}

export function isFixturePath(relPath) {
  return FIXTURE_PATTERN.test(relPath);
}
