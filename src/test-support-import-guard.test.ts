// bdboard-7lrm: *-test-support.ts(x) files (and *-test-support/ directories, e.g.
// src/interface/http/agent-run-routes-test-support/) exist only to give tests shared
// fakes/fixtures, and are intentionally allowlisted by scans such as
// src/infrastructure/runners/runner-reachability.test.ts (see its
// RUNNER_REFERENCE_ALLOWLIST_FILES comment for
// agent-run-routes-test-support/{run-deps,routes}.ts). That allowlisting is a silent backdoor
// unless something else guarantees the allowlisted surface stays test-only: PR #599 added such
// an allowlist entry unconditionally, on an opus review non-blocker note, with no check that
// agent-run-routes-test-support.ts (or its siblings routes-test-support.ts /
// chat-routes-test-support.ts) is never imported by production code. This test is that check,
// generalized to every path containing a `*-test-support` file or directory segment in the
// repository (both the server tree under src/ and the browser tree under web/src/, e.g.
// web/src/components/ChatPanel-test-support.tsx). It intentionally does NOT extend to
// differently-named test helpers such as src/domain/test-support.ts (no hyphen prefix, so it
// does not match the `*-test-support.ts` pattern the ticket's acceptance criteria names) or
// src/infrastructure/process/*.test-support.ts (dot separator, not hyphen) — neither is
// allowlisted by runner-reachability.test.ts today, so extending scope to them is not needed to
// close the gap this ticket is about; a follow-up ticket can widen the pattern if either of
// those is ever added to an allowlist.
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * リポジトリルートの絶対パス。**このファイルが `src/` 直下に置かれている**ことを前提にした `..` である
 * (src/mirrored-files-are-in-sync.test.ts / src/vitest-mock-cleanup-pairing.test.ts と同じ前提)。
 */
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** *-test-support ファイル/ディレクトリは server (src/) と browser (web/src/) の両方にある。 */
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
 * パスの1セグメント(ディレクトリ名、または拡張子つきファイル basename)が test-support 面かどうか。
 * ディレクトリ名 (`agent-run-routes-test-support`) は拡張子を持たないので拡張子部分は任意にし、
 * ファイル名 (`hygiene-test-support.ts`) は拡張子つきで一致させる。
 */
const TEST_SUPPORT_SEGMENT_PATTERN = /-test-support(\.tsx?)?$/;

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
 * パス (ディスク上の相対パス、または import 指定子) のどれかのセグメントが test-support 面か。
 * ディレクトリ丸ごと(`agent-run-routes-test-support/`)配下のどのファイルを指していても、
 * その1階層のディレクトリ名が一致すれば test-support と判定する — 個々のファイル名
 * (`run-deps.ts` 等)がたまたま `-test-support` を含まなくても見逃さないため。
 *
 * import 指定子の最終セグメントだけは、src/ 側の NodeNext 解決が使う `.js`/`.jsx` を
 * `.ts`/`.tsx` に読み替えてから判定する (`from './hygiene-test-support.js'` はソース上は
 * `hygiene-test-support.ts` を指す)。web/ 側の bundler 解決は拡張子省略のままなので、この
 * 読み替えを通しても素通しできる。ディスク上の相対パスは常に実拡張子を持つファイルなので
 * 読み替えは不要 (最終セグメントも他のセグメントと同じ判定でよい)。
 */
function pathHasTestSupportSegment(pathLike: string, { normalizeFinalExtension = false } = {}): boolean {
  const segments = pathLike.split('/').filter((segment) => segment !== '' && segment !== '.' && segment !== '..');
  return segments.some((segment, index) => {
    const isFinal = index === segments.length - 1;
    const candidate =
      isFinal && normalizeFinalExtension
        ? segment.replace(/\.jsx$/, '.tsx').replace(/\.js$/, '.ts')
        : segment;
    return TEST_SUPPORT_SEGMENT_PATTERN.test(candidate);
  });
}

describe('*-test-support.ts(x) import guard (bdboard-7lrm)', () => {
  it('is imported only by *.test.ts(x) files or other *-test-support files', () => {
    const violations: string[] = [];

    for (const root of SCAN_ROOTS) {
      for (const file of collectCodeFiles(path.join(REPO_ROOT, root))) {
        const relativePath = toRepoRelativePosix(file);
        const basename = path.basename(file);
        // 検査の対象は「テストでも test-support 面でもない」ファイルからの import だけ。
        // *.test.ts(x) が test-support を使うのは想定どおりで、*-test-support/ ディレクトリの
        // 中身同士が互いに import し合う (例: agent-run-routes-test-support/routes.ts が同じ
        // ディレクトリの run-deps.ts を使う) のも、外部の agent-run-routes-test-support.ts が
        // そのディレクトリへ再エクスポートするのも許す。現状、*-test-support.ts(x) ファイル同士
        // (ディレクトリをまたいだもの) の import は無いが、将来のモジュール分割に備えてここで
        // 一括して許す (ハイフン無しの src/domain/test-support.ts をここから import するのは
        // 許されるが、それ自体はこの検査の対象外のファイルなので無関係)。
        if (TEST_FILE_BASENAME_PATTERN.test(basename) || pathHasTestSupportSegment(relativePath)) {
          continue;
        }

        const sourceText = readFileSync(file, 'utf8');

        for (const specifier of importSpecifiers(sourceText)) {
          if (!specifier.startsWith('.')) continue; // 相対 import だけを見る (npm パッケージは対象外)。
          if (pathHasTestSupportSegment(specifier, { normalizeFinalExtension: true })) {
            violations.push(`${relativePath} imports ${specifier}`);
          }
        }
      }
    }

    expect(
      violations,
      violations.length > 0
        ? `*-test-support files must only be imported by *.test.ts(x) files or other ` +
            `*-test-support files: ${violations.join('; ')}`
        : '*-test-support files must stay reachable only from tests',
    ).toEqual([]);
  });

  // 走査が空振りして素通しするのを防ぐ下限 (vitest-mock-cleanup-pairing.test.ts と同じ考え方)。
  // *-test-support ファイル/ディレクトリが全部リネーム/削除されると、上のテストは何もチェックしない
  // まま黙って緑になる。両方の走査対象ツリーに実在することと、ディレクトリ形態
  // (agent-run-routes-test-support/ のような分割)も見つかることを固定する。
  it('finds at least one *-test-support file, and at least one *-test-support/ directory, under the scanned roots', () => {
    const rootsWithTestSupportFiles = new Set<string>();
    let foundTestSupportDirectory = false;

    for (const root of SCAN_ROOTS) {
      for (const file of collectCodeFiles(path.join(REPO_ROOT, root))) {
        const relativePath = toRepoRelativePosix(file);
        if (TEST_SUPPORT_SEGMENT_PATTERN.test(path.basename(file))) {
          rootsWithTestSupportFiles.add(root);
        }
        const directorySegments = relativePath.split('/').slice(0, -1);
        if (directorySegments.some((segment) => TEST_SUPPORT_SEGMENT_PATTERN.test(segment))) {
          foundTestSupportDirectory = true;
        }
      }
    }

    expect([...rootsWithTestSupportFiles].sort()).toEqual([...SCAN_ROOTS].sort());
    expect(foundTestSupportDirectory).toBe(true);
  });
});
