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
 * 「正本の内容から一意に導ける文字列とミラーが byte 一致すること」。導出は共有の
 * `deriveMirror()` 1 本で、ペアごとに変えられるのは `headerNotes` (出所ヘッダーに足す説明行) と
 * `rewrites` (`replaceExactlyOnce` で順に当てる文字列置換) だけ。許される差分は**そこに
 * データとして列挙されたものだけ**で、ペアが任意のコードを差し込む余地は無い (bdboard-8x2e)。
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
 * 未登録ミラー走査で、どの深さでも降下しないディレクトリ名。
 *
 * 依存物・生成物・テスト成果物を除く。走査から外れるのはここと `SCAN_EXCLUDED_REPO_PATHS`、
 * そして**ディレクトリの symlink** の 3 つ。`readdirSync(..., { withFileTypes: true })` の
 * dirent は lstat 相当なので、ディレクトリ symlink は `isDirectory()` が false になり降下しない。
 * これは荷重のかかった挙動で、`.claude/worktrees` の除外を symlink 経由で迂回できないことを
 * 保証している — 「symlink も辿るべきでは」と親切心で直すと、そこに静かな穴が開く。
 */
const SCAN_EXCLUDED_DIRECTORY_NAMES = new Set([
  'node_modules',
  'dist',
  '.git',
  '.dolt',
  'logs',
  'coverage',
  'test-results',
  'playwright-report',
  'blob-report',
]);

/**
 * 未登録ミラー走査で降下しないリポジトリ相対パス。
 *
 * `.claude/worktrees` の除外はコストではなく**正しさ**に効く。メインチェックアウトから走ると
 * 兄弟 worktree 側の `web/src/compare.ts` が未登録ミラーとして拾われ、main が赤くなる
 * (実測: worktree 12 本で偽ヒット 24 件)。`.gitignore` 済みなので CI のランナーには存在せず、
 * そちらでは no-op。
 *
 * `.beads` は丸ごと除外する。ここにコードファイルは 1 件も無い一方、`.beads/dolt` は 171 MB の
 * Dolt 作業ディレクトリで、**別セッションの `bd` が随時書き換えている**。降下すると
 * `readdirSync` と再帰の間にサブディレクトリが消えて `ENOENT: scandir` で落ちうる
 * (マージ後にメインチェックアウトで `npm run verify` を回している最中が一番踏みやすい)。
 * その赤はミラーと無関係な scandir エラーとして出るので、読んだ人は間違った場所を調べ始める。
 * `.beads/.gitignore` が `dolt/` `embeddeddolt/` `proxieddb/` を並べて無視していることからも、
 * 個別に列挙するのではなく親ごと落とすのが素直。
 */
const SCAN_EXCLUDED_REPO_PATHS = new Set(['.claude/worktrees', '.beads']);

/**
 * 未登録ミラー走査の対象となるコードファイルの拡張子。Markdown は出所ヘッダーを引用しただけの
 * ドキュメントを誤検出しうるため含めない。
 */
const SCAN_FILE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);

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
  /** 出所ヘッダーのマーカー行に続く補足行 (各行は `// ` を付けて出力される)。 */
  readonly headerNotes: readonly string[];
  /** ミラーで許される書き換えの全体 (これ以外の差分は許されない)。順に replaceExactlyOnce される。 */
  readonly rewrites: readonly { readonly from: string; readonly to: string }[];
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

/**
 * 構造化した出所ヘッダーと列挙済みの書き換えだけからミラーを導出する。
 *
 * 任意の関数を持たせず許される差分をデータとして列挙することで、未宣言の書き換えを差し込む
 * 余地をなくす。replaceExactlyOnce で表現できない変換が必要になったらデータ表現を拡張し、
 * 関数のエスケープハッチは戻さない。ヘッダーの正本パスは pair.canonicalPath から構造的に作る。
 */
function deriveMirror(pair: MirrorPair, canonicalContent: string): string {
  return (
    mirrorHeader(pair.canonicalPath, pair.headerNotes) +
    pair.rewrites.reduce(
      (content, { from, to }) => replaceExactlyOnce(content, from, to),
      canonicalContent,
    )
  );
}

const MIRROR_PAIRS: readonly MirrorPair[] = [
  {
    canonicalPath: 'src/domain/compare.ts',
    mirrorPath: 'web/src/compare.ts',
    headerNotes: ['Mirrored here because web cannot import src/ directly.'],
    rewrites: [],
  },
  {
    canonicalPath: 'src/domain/compare.test.ts',
    mirrorPath: 'web/src/compare.test.ts',
    headerNotes: [
      'Mirrored here because web cannot import src/ directly.',
      'Apart from this provenance header, the only other difference is the import specifier:',
      'the root project resolves with NodeNext (explicit .js), web/ with bundler resolution.',
    ],
    rewrites: [{ from: "from './compare.js';", to: "from './compare';" }],
  },
];

function readNormalized(repoRelativePath: string): string {
  return readFileSync(path.join(REPO_ROOT, repoRelativePath), 'utf8').replace(/\r\n/g, '\n');
}

function toRepoRelativePosix(absolutePath: string): string {
  return path.relative(REPO_ROOT, absolutePath).split(path.sep).join('/');
}

function collectCodeFiles(directory: string): readonly string[] {
  const files: string[] = [];

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      const repoRelativePath = toRepoRelativePosix(absolutePath);
      if (
        !SCAN_EXCLUDED_DIRECTORY_NAMES.has(entry.name) &&
        !SCAN_EXCLUDED_REPO_PATHS.has(repoRelativePath)
      ) {
        files.push(...collectCodeFiles(absolutePath));
      }
      continue;
    }

    if (entry.isFile() && SCAN_FILE_EXTENSIONS.has(path.extname(entry.name))) {
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
      const expected = deriveMirror(pair, canonicalContent);
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

  it('registers every marked code file in the repository, regardless of header position', () => {
    const markedMirrors: string[] = [];

    for (const absolutePath of collectCodeFiles(REPO_ROOT)) {
      const normalizedContent = readFileSync(absolutePath, 'utf8')
        .replace(/\r\n/g, '\n')
        .replace(/^\uFEFF/, '');
      if (normalizedContent.split('\n').some((line) => line.startsWith(MIRROR_MARKER_LINE_PREFIX))) {
        markedMirrors.push(toRepoRelativePosix(absolutePath));
      }
    }

    const registeredMirrors = MIRROR_PAIRS.map((pair) => pair.mirrorPath);

    expect(
      markedMirrors.sort(),
      `code files containing a line that starts with ${JSON.stringify(MIRROR_MARKER_LINE_PREFIX)} must match ` +
        `MIRROR_PAIRS of ${toRepoRelativePosix(SELF_ABSOLUTE_PATH)} exactly (both directions): a new mirror ` +
        'must be registered there, and a registered mirror must keep its header line. ' +
        'If the unexpected file is NOT a mirror (a generator template or a fixture that merely quotes the header ' +
        'line at column 0), do not register it: either move it out of the scanned extensions or add its path to ' +
        'SCAN_EXCLUDED_REPO_PATHS with a comment saying why. The repository-wide scan includes only ' +
        `${[...SCAN_FILE_EXTENSIONS].join(', ')} ` +
        `files and excludes directories named ${[...SCAN_EXCLUDED_DIRECTORY_NAMES].join(', ')} plus ` +
        `repository paths ${[...SCAN_EXCLUDED_REPO_PATHS].join(', ')}.`,
    ).toEqual([...registeredMirrors].sort());
  });
});
