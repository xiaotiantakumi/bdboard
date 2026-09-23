// scripts/check-file-size.mjs から切り出した定数群 (対象ディレクトリ・拡張子・baseline
// 設定の相対パス・exit code)。bdboard-sso1.58: move-only 分割。
export const CONFIG_RELATIVE_PATH = 'scripts/file-size-baseline.json';

// 対象ディレクトリ・拡張子。パスは常に git ls-files が返す POSIX 区切りの相対パスとして
// 扱う — Windows でも git は '/' 区切りで返すため、このスクリプトは path.sep を一度も
// 使わない (verify-windows 対策)。
export const TARGET_DIRS = ['src', 'web/src', 'scripts', 'harness', 'test'];
export const TARGET_EXTENSIONS = ['.tsx', '.ts', '.mjs', '.js', '.css', '.sh'];

export const EXIT_OK = 0;
export const EXIT_FOUND = 1;
export const EXIT_UNAVAILABLE = 2;
