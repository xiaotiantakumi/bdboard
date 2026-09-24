// scripts/check-file-size.mjs から切り出したパス分類 (対象パス判定・テストファイル判定・
// fixtures 判定)。bdboard-sso1.58: move-only 分割。
import { TARGET_DIRS, TARGET_EXTENSIONS } from './constants.mjs';

const TEST_PATTERN = /\.(test|spec)\.[^./]+$/;
const FIXTURE_PATTERN = /(^|\/)fixtures(\/|$)/;

// bdboard-sso1.8: ESLint max-lines 対象の拡張子はディレクトリごとに異なるため、
// eslint.config.mjs の files globs に合わせて管理する。ESLint が見ない拡張子
// (web/src/index.css 等) は引き続きここで見る。harness/ (ESLint の ignores 対象) と
// test/ (ESLint の lint 対象外、test/e2e/*.ts など) は二重管理の対象にならないため、
// 従来どおり全拡張子を見る。
// bdboard-hncr: eslint.config.mjs 166行目の files と1対1で対応させる。単一配列だと
// src/foo.js のような組み合わせを「ESLint 対象」と誤判定し、check-file-size と ESLint
// max-lines の両方から漏れる穴になっていた。この対応がずれたら下のテストの
// 「eslint.config.mjs drift guard」が落ちる。
const ESLINT_COVERED_EXTENSIONS_BY_DIR = {
  src: ['.ts'],
  'web/src': ['.ts', '.tsx'],
  scripts: ['.mjs'],
};

/**
 * 対象ディレクトリ配下 かつ 対象拡張子 か (fixtures 判定はここに含めない)。
 * ESLint max-lines の対象ディレクトリでは、該当ディレクトリで実際に見る拡張子を
 * ここでは対象外にする (二重管理の防止)。
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
  const eslintExtensions = ESLINT_COVERED_EXTENSIONS_BY_DIR[matchedDir] ?? [];
  if (eslintExtensions.some((ext) => relPath.endsWith(ext))) {
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
