import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const IMPORT_RE = /^@import\s+'([^']+)';\s*$/;

/**
 * bdboard-sso1.3: `index.css` は分割後、`@import './styles/<name>.css';` だけを
 * 並べた入口ファイルになった。分割前の index.css を「テキストとして」読んで
 * カスタムプロパティ/@media/クラス定義を検査していたテスト群 (index.css.*.test.ts,
 * mediaQueries.test.ts, HygienePanel.badge-colors.test.ts など) は、分割後も
 * 同じ全文を読めないと壊れる。
 *
 * この関数は `entryPath` から `@import '<relative>';` 行を元の出現順のまま
 * 再帰的にインライン展開し、分割前の index.css と一致する連結テキストを返す。
 * @import 以外の行はそのまま通す。分割によって生まれた `web/src/styles/*.css` は
 * どれも @import を含まない葉ファイルなので、実際には1階層の展開で足りるが、
 * 将来さらにネストしても壊れないよう再帰的に解決する。
 *
 * 分割は「移動のみ」(内容・順序を一切変えない) が要件なので、この関数の出力は
 * 分割前の index.css のバイト列と完全に一致する — 呼び出し側のテストの
 * アサーションは変更不要。
 */
export function resolveCssImports(entryPath: string): string {
  const raw = readFileSync(entryPath, 'utf8');
  const dir = dirname(entryPath);
  const lines = raw.split('\n');
  const parts: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = IMPORT_RE.exec(line);
    if (match) {
      const importedPath = resolve(dir, match[1]);
      parts.push(resolveCssImports(importedPath));
      continue;
    }
    // Fail loudly rather than silently passing through an @import form this
    // resolver doesn't understand (double quotes, url(), layer(), leading
    // whitespace, ...): a test that scans the "full" resolved text for e.g. a
    // bare `dvh` unit or a brace-balance count must never pass vacuously
    // because a chunk of CSS quietly failed to get inlined.
    if (/^\s*@import\b/.test(line)) {
      throw new Error(
        `resolveCssImports: unrecognized @import syntax in ${entryPath} at line ${i + 1}: ${line}`,
      );
    }
    // preserve the line, and the newline that followed it in the original file
    // (split('\n') drops them; re-add except after the very last line).
    parts.push(i < lines.length - 1 ? `${line}\n` : line);
  }
  return parts.join('');
}
