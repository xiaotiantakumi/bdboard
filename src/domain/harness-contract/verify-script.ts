import { normalizeProjectRelativePath } from '../harness-path.js';

/** `verify` が npm 系の run コマンドだったときの、実体を探す先。 */
export interface VerifyScriptRequirement {
  /** プロジェクトルートからの相対ディレクトリ (POSIX)。ルート直下なら `.`。 */
  readonly packageDir: string;
  /** package.json の scripts に存在すべきキー。 */
  readonly script: string;
}

const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn']);
const DIR_FLAGS = new Set(['--prefix', '--dir', '--cwd', '-C']);
/** シェルの合成が入った時点で「1本のスクリプト起動」ではないので検査を諦める。 */
const SHELL_METACHARACTERS = /[|&;<>$`'"()]/;

/**
 * `verify` から「注入先の package.json に存在すべき npm script」を割り出す。
 *
 * 検出できるのは `npm run <script>` / `npm --prefix <dir> run <script>` /
 * `pnpm run` / `yarn run` の形だけ。`make verify` や `python -c "..."` のような
 * 形はコマンド実体を検査しない (null) — 検証コマンドの実在確認は「安く確実に
 * できる範囲だけやる」のが方針で、任意コマンドの存在確認は範囲外。
 */
export function resolveVerifyScriptRequirement(
  verify: string,
): VerifyScriptRequirement | null {
  if (SHELL_METACHARACTERS.test(verify)) {
    return null;
  }

  const tokens = verify.trim().split(/\s+/).filter((token) => token.length > 0);
  if (tokens.length === 0 || !PACKAGE_MANAGERS.has(tokens[0]!)) {
    return null;
  }

  let index = 1;
  let packageDir = '.';

  while (index < tokens.length) {
    const token = tokens[index]!;
    if (DIR_FLAGS.has(token)) {
      const value = tokens[index + 1];
      if (value === undefined) {
        return null;
      }
      packageDir = value;
      index += 2;
      continue;
    }

    const inlineDir = /^(--prefix|--dir|--cwd)=(.+)$/.exec(token);
    if (inlineDir !== null) {
      packageDir = inlineDir[2]!;
      index += 1;
      continue;
    }

    break;
  }

  if (tokens[index] !== 'run') {
    return null;
  }

  const script = tokens[index + 1];
  if (script === undefined || script.startsWith('-')) {
    return null;
  }

  if (packageDir === '.' || packageDir === './') {
    return { packageDir: '.', script };
  }

  // プロジェクト外を指す prefix は「検査しない」に倒す。注入先の任意の JSON から
  // 読み出したパスなので、注入 API と同じくルート脱出は素通りさせない。
  const normalized = normalizeProjectRelativePath(packageDir);
  if (normalized === null) {
    return null;
  }

  return { packageDir: normalized, script };
}
