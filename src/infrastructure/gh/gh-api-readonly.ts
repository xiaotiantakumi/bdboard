// `gh api` は -f / -F / --field / --raw-field / --input を 1 つでも付けると、メソッドの
// 既定が GET から POST に切り替わる。この reader 群は GitHub へ書き込まないので、組み立てた
// 引数が GET 専用であることを実行の直前に確かめる (テストでも引数を固定している。二重の備え)。

const WRITE_LONG_FLAGS = new Set(['--field', '--raw-field', '--input']);

function isWriteFlag(arg: string): boolean {
  if (arg.startsWith('--')) {
    return WRITE_LONG_FLAGS.has(arg.split('=')[0]);
  }
  // 短い形: -f / -F / -X と、付着 (-fkey=value, -XPOST) や束ね (-if) も含める。
  return /^-[A-Za-z]*[fFX]/.test(arg);
}

/**
 * `gh api` の引数が GET 専用でなければ Error を投げる。拒否するもの: 先頭が `api` でない /
 * 書き込み系のフラグ (`-f` `-F` `--field` `--raw-field` `--input`、その `=` 形・付着形・束ね形)
 * と `-X` / `-XPOST` / `--method=…` / `--method GET` 以外 (無い・2 回・GET 以外)。
 */
export function assertReadOnlyGhApiArgs(args: readonly string[]): void {
  if (args[0] !== 'api') {
    throw new Error('gh api arguments must begin with "api"');
  }
  const writeFlag = args.find(isWriteFlag);
  if (writeFlag !== undefined) {
    throw new Error(`gh api write argument is forbidden: ${writeFlag}`);
  }
  const methodIndexes = args.flatMap((arg, index) => (arg === '--method' ? [index] : []));
  const hasInlineMethod = args.some((arg) => arg.startsWith('--method='));
  if (methodIndexes.length !== 1 || hasInlineMethod || args[methodIndexes[0] + 1] !== 'GET') {
    throw new Error('gh api arguments must contain exactly one "--method GET"');
  }
}
