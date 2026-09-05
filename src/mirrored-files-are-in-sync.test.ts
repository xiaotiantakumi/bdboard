import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * 「正本 + ミラー」で二重化されているファイルの同期を機械で固定する (bdboard-8fh0)。
 *
 * `.dependency-cruiser.cjs` の `web-no-server-src` / `server-no-web` により web/ と src/ は
 * 互いに import できない。そのため `compareStrings` は src/domain/ に正本を置き、web/src/ に
 * 手でコピーしたミラーを置いている。これまで同期の根拠はミラー冒頭のコメントだけの紳士協定で、
 * 片方だけ変えてもテストは緑のままだった (PR #386 / bdboard-254q の JSDoc 修正で実際に手作業が
 * 必要になった)。
 *
 * ## 何を不変条件にするか
 *
 * 「正本の内容から一意に導ける文字列とミラーが byte 一致すること」。各ペアの `deriveMirror` が
 * その全域変換で、許される差分 (出所ヘッダー・import 指定子) はそこに**列挙されたものだけ**。
 * ticket の当初案にあった「`export function compareStrings` 以降だけ比較する」は採らない —
 * それだと JSDoc のドリフトを素通しし、このチケットの発端 (#386 の JSDoc 修正) をまさに
 * 検出できない。
 *
 * 先例 `src/infrastructure/harness/injected-pack-is-in-sync.test.ts` は正本と注入コピーが
 * copyPackFile() の byte コピーで作られるため素の sha256 比較で足りる。ここは違って、ミラーが
 * 正本と byte 一致「してはいけない」(出所ヘッダーを持つ) ので、比較の前に宣言済みの変換を挟む。
 *
 * ## 改行コード
 *
 * 比較前に CRLF を LF へ正規化する。`.gitattributes` は `scripts/fixtures/*.txt` しか eol を
 * 固定しておらず、Windows の `core.autocrlf=true` チェックアウト (CI に verify-windows がある)
 * では両ファイルとも CRLF になる。両側へ等しく掛ける正規化なので、隠せるのは 2 ファイル間の
 * 改行コードの差だけで、内容のドリフトは隠せない。
 */

/**
 * リポジトリルートの絶対パス。
 *
 * **このファイルがリポジトリルートの 1 階層下 (`src/` 直下) に置かれている**ことを前提にした
 * `..` である。`src/` のサブディレクトリなど別の深さへ移すと REPO_ROOT が静かにずれ、以降の
 * 読み込みが「なぜそのパスなのか」を説明しない ENOENT になる。移動するなら段数も直すこと。
 */
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** ミラー冒頭に置く出所マーカー。 */
const MIRROR_MARKER = 'Canonical implementation:';

/**
 * 出所ヘッダー 1 行目の接頭辞。`mirrorHeader()` が組み立てる先頭でもあり、未登録のミラーを
 * 炙り出す走査 (下の it) の錨でもある。両者が同じ定数を使うことで、マーカー文字列に言及した
 * だけのファイル (1つ上で MIRROR_MARKER を定義しているこのファイル自身がまさにそれ) を走査が
 * ミラーと取り違えない。
 */
const MIRROR_MARKER_LINE_PREFIX = `// ${MIRROR_MARKER} `;

/**
 * マーカー走査の対象ルート。走査するのはこの 2 ルート配下の `.ts` / `.tsx` だけで、
 * `scripts/` や `test/` や `web/` 直下、`.mjs` は見ていない (範囲の拡大は別チケット)。
 * `node_modules` はこの下に無いが、念のため降下時に弾く。
 */
const SCAN_ROOTS = ['src', 'web/src'] as const;

/**
 * このファイル自身の絶対パス。失敗時に「どこへ登録すればよいか」を指すために使う。
 * パスをハードコードせず import.meta から取るので、リネームしても指し先が腐らない。
 */
const SELF_ABSOLUTE_PATH = fileURLToPath(import.meta.url);

interface MirrorPair {
  /** リポジトリ相対 (posix) の正本パス。 */
  readonly canonicalPath: string;
  /** リポジトリ相対 (posix) のミラーパス。 */
  readonly mirrorPath: string;
  /**
   * 正本の内容からミラーの内容を一意に導く全域変換。ここに書かれていない差分は許されない。
   *
   * 第 2 引数には上の `canonicalPath` がそのまま渡る。出所ヘッダーに書く正本パスを
   * リテラルで持たせないためで、リテラルだと `canonicalPath` と照合されず、ミラーが
   * 実在しない (あるいは別の) 正本を名乗っていてもこのテストが緑のままになる。
   */
  readonly deriveMirror: (canonicalContent: string, canonicalPath: string) => string;
}

/** ミラー冒頭の出所ヘッダー (マーカー行 + 補足行 + 空行) を組み立てる。 */
function mirrorHeader(canonicalPath: string, noteLines: readonly string[]): string {
  return [
    `${MIRROR_MARKER_LINE_PREFIX}${canonicalPath}`,
    ...noteLines.map((line) => `// ${line}`),
    '',
    '',
  ].join('\n');
}

/**
 * `from` がちょうど 1 箇所のときだけ置換する。0 箇所や 2 箇所以上で黙って no-op にすると、
 * 正本側の変更で変換が意味を失っても緑のままになりうるため、そこで落とす。
 *
 * 置換は関数リプレーサで行う。文字列を渡すと `to` の中の `$&` / `$1` / `` $` `` が置換パターン
 * として解釈され、リテラルとして書いたつもりの `to` が黙って別物になるため。
 */
function replaceExactlyOnce(source: string, from: string, to: string): string {
  const occurrences = source.split(from).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `mirror derivation expected exactly 1 occurrence of ${JSON.stringify(from)}, found ${occurrences}`,
    );
  }
  return source.replace(from, () => to);
}

const MIRROR_PAIRS: readonly MirrorPair[] = [
  {
    canonicalPath: 'src/domain/compare.ts',
    mirrorPath: 'web/src/compare.ts',
    deriveMirror: (canonicalContent, canonicalPath) =>
      mirrorHeader(canonicalPath, ['Mirrored here because web cannot import src/ directly.']) +
      canonicalContent,
  },
  {
    canonicalPath: 'src/domain/compare.test.ts',
    mirrorPath: 'web/src/compare.test.ts',
    deriveMirror: (canonicalContent, canonicalPath) =>
      mirrorHeader(canonicalPath, [
        'Mirrored here because web cannot import src/ directly.',
        'Apart from this provenance header, the only other difference is the import specifier:',
        'the root project resolves with NodeNext (explicit .js), web/ with bundler resolution.',
      ]) + replaceExactlyOnce(canonicalContent, "from './compare.js';", "from './compare';"),
  },
];

function readNormalized(repoRelativePath: string): string {
  return readFileSync(path.join(REPO_ROOT, repoRelativePath), 'utf8').replace(/\r\n/g, '\n');
}

function toRepoRelativePosix(absolutePath: string): string {
  return path.relative(REPO_ROOT, absolutePath).split(path.sep).join('/');
}

function collectSourceFiles(directory: string): readonly string[] {
  const files: string[] = [];

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') {
        files.push(...collectSourceFiles(absolutePath));
      }
      continue;
    }

    if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx'))) {
      files.push(absolutePath);
    }
  }

  return files;
}

/** 失敗時に「どの行から食い違ったか」を 1 行で指すための補助。 */
function describeFirstDifference(expected: string, actual: string): string {
  const expectedLines = expected.split('\n');
  const actualLines = actual.split('\n');
  const lineCount = Math.max(expectedLines.length, actualLines.length);

  for (let index = 0; index < lineCount; index += 1) {
    const expectedLine = expectedLines[index];
    const actualLine = actualLines[index];
    if (expectedLine !== actualLine) {
      const render = (line: string | undefined): string =>
        line === undefined ? '<end of file>' : JSON.stringify(line);
      return [
        `first difference at line ${index + 1}`,
        `  expected (derived from canonical): ${render(expectedLine)}`,
        `  actual   (mirror on disk):         ${render(actualLine)}`,
      ].join('\n');
    }
  }

  return 'no line-level difference';
}

describe('mirrored files are in sync with their canonical source', () => {
  for (const pair of MIRROR_PAIRS) {
    it(`${pair.mirrorPath} is derivable from ${pair.canonicalPath}`, () => {
      const canonicalContent = readNormalized(pair.canonicalPath);
      const expected = pair.deriveMirror(canonicalContent, pair.canonicalPath);
      const actual = readNormalized(pair.mirrorPath);

      expect(
        actual,
        [
          `${pair.mirrorPath} drifted from its canonical source ${pair.canonicalPath}.`,
          'Apply the same change to both files (the mirror keeps only the provenance header',
          `and the differences declared in MIRROR_PAIRS of ${toRepoRelativePosix(SELF_ABSOLUTE_PATH)}).`,
          describeFirstDifference(expected, actual),
        ].join('\n'),
      ).toBe(expected);
    });
  }

  it('registers every .ts/.tsx file under src/ and web/src/ that starts with the marker line', () => {
    const markedMirrors: string[] = [];

    for (const scanRoot of SCAN_ROOTS) {
      for (const absolutePath of collectSourceFiles(path.join(REPO_ROOT, scanRoot))) {
        if (readFileSync(absolutePath, 'utf8').startsWith(MIRROR_MARKER_LINE_PREFIX)) {
          markedMirrors.push(toRepoRelativePosix(absolutePath));
        }
      }
    }

    const registeredMirrors = MIRROR_PAIRS.map((pair) => pair.mirrorPath);

    expect(
      markedMirrors.sort(),
      `files whose first line is a ${JSON.stringify(MIRROR_MARKER_LINE_PREFIX)} header must match ` +
        'MIRROR_PAIRS exactly (both directions): a new mirror must be registered here, and a ' +
        'registered mirror must keep its header line. This scan only covers ' +
        `${SCAN_ROOTS.join(' and ')} (.ts/.tsx only, node_modules skipped), so mirrors placed ` +
        'elsewhere are not seen by it.',
    ).toEqual([...registeredMirrors].sort());
  });
});
