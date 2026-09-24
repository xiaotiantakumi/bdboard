// bdboard-7lrm: *-test-support.ts(x) files exist only to give tests shared fakes/fixtures, and
// are intentionally allowlisted by scans such as
// src/infrastructure/runners/runner-reachability.test.ts (see its
// RUNNER_REFERENCE_ALLOWLIST_FILES comment for agent-run-routes-test-support.ts). That
// allowlisting is a silent backdoor unless something else guarantees the file stays test-only:
// PR #599 added such an allowlist entry unconditionally, on an opus review non-blocker note,
// with no check that agent-run-routes-test-support.ts (or its siblings routes-test-support.ts /
// chat-routes-test-support.ts) is never imported by production code. This test is that check,
// generalized to every `*-test-support.ts`/`*-test-support.tsx` file in the repository (both the
// server tree under src/ and the browser tree under web/src/, e.g.
// web/src/components/ChatPanel-test-support.tsx).
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * リポジトリルートの絶対パス。**このファイルが `src/` 直下に置かれている**ことを前提にした `..` である
 * (src/mirrored-files-are-in-sync.test.ts / src/vitest-mock-cleanup-pairing.test.ts と同じ前提)。
 */
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** *-test-support ファイルは server (src/) と browser (web/src/) の両方にある。 */
const SCAN_ROOTS = ['src', 'web/src'];

const SCAN_EXCLUDED_DIRECTORY_NAMES = new Set([
  'node_modules',
  'dist',
  '.git',
  'coverage',
  'test-results',
  'playwright-report',
  'blob-report',
]);

const SCAN_FILE_EXTENSIONS = new Set(['.ts', '.tsx']);

/**
 * ディスク上の実ファイル名 (拡張子つき) と、import 指定子から取り出した basename (拡張子が
 * 無い場合もある。web/ 側は bundler 解決で `from './ChatPanel-test-support'` のように拡張子を
 * 省略する) の両方にマッチさせるため、拡張子部分は任意にする。
 */
const TEST_SUPPORT_BASENAME_PATTERN = /-test-support(\.tsx?)?$/;

const TEST_FILE_BASENAME_PATTERN = /\.test\.tsx?$/;

/**
 * `from '...'` / 裸の `import '...'` / `require('...')` / 動的 `import('...')` の指定子を拾う。
 * TS parser は使わず正規表現で十分 (runner-reachability.test.ts の
 * RUNNER_REFERENCE_TOKENS 文字列スキャンと同じ割り切り): コメントや文字列中の偶然の一致を
 * 拾う可能性はあるが、この検査は import グラフの外形を見るものであり、誤検知が出たら
 * `*-test-support` という基底名を含む行を書いた側の問題として調べれば足りる。
 */
const IMPORT_SPECIFIER_PATTERN =
  /\bimport\s+['"]([^'"]+)['"]|\bfrom\s+['"]([^'"]+)['"]|\brequire\(\s*['"]([^'"]+)['"]\s*\)|\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;

function toRepoRelativePosix(absolutePath: string): string {
  return path.relative(REPO_ROOT, absolutePath).split(path.sep).join('/');
}

function collectCodeFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!SCAN_EXCLUDED_DIRECTORY_NAMES.has(entry.name)) {
        files.push(...collectCodeFiles(absolutePath));
      }
    } else if (entry.isFile() && SCAN_FILE_EXTENSIONS.has(path.extname(entry.name))) {
      files.push(absolutePath);
    }
  }
  return files;
}

function importSpecifiers(sourceText: string): string[] {
  const specifiers: string[] = [];
  for (const match of sourceText.matchAll(IMPORT_SPECIFIER_PATTERN)) {
    const specifier = match[1] ?? match[2] ?? match[3] ?? match[4];
    if (specifier !== undefined) specifiers.push(specifier);
  }
  return specifiers;
}

/**
 * import 指定子から basename を取り出し、src/ 側の NodeNext 解決が使う `.js`/`.jsx` を
 * `.ts`/`.tsx` に読み替える (`from './hygiene-test-support.js'` はソース上は
 * `hygiene-test-support.ts` を指す)。web/ 側の bundler 解決は拡張子省略 (`.js` を付けない) の
 * ままなので、この読み替えを通しても素通しできる。
 */
function normalizedImportBasename(specifier: string): string {
  return path
    .basename(specifier)
    .replace(/\.jsx$/, '.tsx')
    .replace(/\.js$/, '.ts');
}

describe('*-test-support.ts(x) import guard (bdboard-7lrm)', () => {
  it('is imported only by *.test.ts(x) files or other *-test-support.ts(x) files', () => {
    const violations: string[] = [];

    for (const root of SCAN_ROOTS) {
      for (const file of collectCodeFiles(path.join(REPO_ROOT, root))) {
        const basename = path.basename(file);
        // 検査の対象は「テストでも test-support でもない」ファイルからの import だけ。
        // *.test.ts(x) が test-support を使うのは想定どおりで、test-support 同士の
        // re-export (現状は無いが将来のモジュール分割に備える) も許す。
        if (TEST_FILE_BASENAME_PATTERN.test(basename) || TEST_SUPPORT_BASENAME_PATTERN.test(basename)) {
          continue;
        }

        const relativePath = toRepoRelativePosix(file);
        const sourceText = readFileSync(file, 'utf8');

        for (const specifier of importSpecifiers(sourceText)) {
          if (!specifier.startsWith('.')) continue; // 相対 import だけを見る (npm パッケージは対象外)。
          if (TEST_SUPPORT_BASENAME_PATTERN.test(normalizedImportBasename(specifier))) {
            violations.push(`${relativePath} imports ${specifier}`);
          }
        }
      }
    }

    expect(
      violations,
      violations.length > 0
        ? `*-test-support.ts(x) files must only be imported by *.test.ts(x) or other ` +
            `*-test-support.ts(x) files: ${violations.join('; ')}`
        : '*-test-support.ts(x) files must stay reachable only from tests',
    ).toEqual([]);
  });

  // 走査が空振りして素通しするのを防ぐ下限 (vitest-mock-cleanup-pairing.test.ts と同じ考え方)。
  // *-test-support ファイルが全部リネーム/削除されると、上のテストは何もチェックしないまま
  // 黙って緑になる。両方の走査対象ツリーに実在することを固定する。
  it('finds at least one *-test-support.ts(x) file under each scanned root', () => {
    const rootsWithTestSupportFiles = new Set<string>();

    for (const root of SCAN_ROOTS) {
      for (const file of collectCodeFiles(path.join(REPO_ROOT, root))) {
        if (TEST_SUPPORT_BASENAME_PATTERN.test(path.basename(file))) {
          rootsWithTestSupportFiles.add(root);
          break;
        }
      }
    }

    expect([...rootsWithTestSupportFiles].sort()).toEqual([...SCAN_ROOTS].sort());
  });
});
