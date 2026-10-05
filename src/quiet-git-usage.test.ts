// bdboard-5py8 (M1): 一時 git repo を作って commit / fetch / push するテストが、git の自動保守を止める補助
// (scripts/test-support/quiet-git.mjs) を使っているかの静的な検査。外し忘れ・付け忘れは、テストが緑のまま
// `git maintenance run --auto --detach` の起動が残り、後始末の rmSync と競合して ENOTEMPTY になる (bdboard-w8hr)。
// 全テストに効く vitest の setupFiles は影響が大きいので入れず、ここでは文字列の走査に留める。
// 判定はテスト/補助ファイルの本文だけを見る: repo を作る (`'init'` が引数配列の要素) ＋ 保守を起こす書き込み
// (`'commit'` / `'fetch'` / `'push'` が引数配列の要素) の両方があれば、quiet-git の補助を呼んでいること。
// import だけ残して呼び出しを外した (RM_OPTIONS だけ使っている、名前だけ import している) 場合も落とすため、import ではなく呼び出しを見る。
// 照合の前にコメント (`//` 行と `/* */`) を除く (bdboard-sl0n): 呼び出しをコメントにだけ残した (外したつもりで説明を残した) ファイルも落とす。
// 除くのは文字列・テンプレートリテラルの外のコメントだけ (`'http://x'` の `//` は残す)。
//
// この検査の限界 (bdboard-sl0n。ここに挙げた形は、補助を付け忘れても緑のまま通る。足すなら判定を変える別の判断):
// - ファイル単位の判定: 1 ファイルのどこかに呼び出しが 1 つあれば満たされる。1 ファイルの中で一部の経路だけ外しても (pack-hooks の
//   `isolatedEnv()` だけ外して `noJqEnv()` に呼び出しが残る、merge-pr の `registerTempRepoHooks()` だけ外して `setup()` に残る) 気づけない。
// - 引数配列の要素の動詞だけを見る: 文字列の git コマンド (`execSync('git commit ...')`)、execa のテンプレート (`` $`git commit` ``)、
//   実行時に組み立てる動詞 (`['comm' + 'it']`、変数に入れた動詞) は書き込みと数えない。
// - repo を作る形は `'init'` だけ: `clone` だけで作る repo (`git clone` した先で commit / push するもの) は選ばれない。
// - 走査するファイルは `*.test.{ts,mjs}` と `*.test-support.*` / `*-test-support.*` だけ。それ以外の名前の補助が git を起こしても、
//   その補助を import するテスト側に引数配列が無ければ選ばれない。
// - 呼び出しの有無だけを見て、効く範囲は見ない: 呼ぶ場所 (describe の外、beforeAll より後の経路)、子プロセスへ env が渡るかは見ない。
// - コメントの除去は文字列・テンプレートリテラルを字句の単位で読むだけで、正規表現リテラル (`/['"]/` の引用符、`/\/*/`) までは読まない。
//   正規表現リテラルの中身を文字列やコメントと取り違えることがありうる。
// - useQuietGitProcessEnv の復元は、別の afterAll が投げると戻らない (vitest 4 の aroundAll 版なら戻る。入れるかは別の判断)。
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/** リポジトリルートの絶対パス。このファイルが `src/` 直下にあることを前提にした `..` (src/test-support-import-guard.test.ts と同じ)。 */
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCAN_DIRS = ['src', 'scripts'];
/** `*.test.ts` / `*.test.mjs` と、その補助 (`*.test-support.*` / `*-test-support.*`)。補助が git を起こすなら補助が import する。 */
const TEST_FILE = /(?:\.test|[.-]test-support)\.(?:ts|mjs)$/;
const CREATES_REPO = /['"`]init['"`]\s*[,\]]/;
const WRITES_REPO = /['"`](?:commit|fetch|push)['"`]\s*[,\]]/;
const CALLS_QUIET_GIT = /\b(?:quietGitEnv|useQuietGitProcessEnv)\(/;
/**
 * 左から順に読み、ブロックコメント・行コメント・文字列 ('..' / ".." / `..`) のどれかを 1 つずつ切り出す。
 * 文字列の中の `//` を行コメントと取り違えないよう、文字列も同じ正規表現で拾って丸ごと残す (先に始まった方が勝つ)。
 */
const COMMENT_OR_STRING = /\/\*[\s\S]*?\*\/|\/\/[^\n]*|'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\[\s\S])*`/g;

/** コメントだけを除く (改行は残すので行の位置は変わらない)。文字列・テンプレートリテラルの中身はそのまま。 */
const stripComments = (source: string): string =>
  source.replace(COMMENT_OR_STRING, (match) => (match.startsWith('/') ? match.replace(/[^\n]/g, '') : match));

const runsGitWrites = (source: string): boolean => {
  const code = stripComments(source);
  return CREATES_REPO.test(code) && WRITES_REPO.test(code);
};
const callsQuietGit = (source: string): boolean => CALLS_QUIET_GIT.test(stripComments(source));

function collectTestFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : collectTestFiles(absolutePath);
    return entry.isFile() && TEST_FILE.test(entry.name) ? [absolutePath] : [];
  });
}

describe('temp git repo tests stop git auto maintenance (bdboard-5py8)', () => {
  // このファイル自身は、判定の確認用に repo を作る/書き込む引数配列の文字列を含むので走査から外す。
  const self = fileURLToPath(import.meta.url);
  const files = SCAN_DIRS.flatMap((dir) => collectTestFiles(path.join(REPO_ROOT, dir))).filter((file) => file !== self);
  const gitWriters = files.filter((file) => runsGitWrites(readFileSync(file, 'utf8')));

  it('calls quietGitEnv or useQuietGitProcessEnv in every test that creates a repo and commits, fetches or pushes', () => {
    const missing = gitWriters
      .filter((file) => !callsQuietGit(readFileSync(file, 'utf8')))
      .map((file) => path.relative(REPO_ROOT, file).split(path.sep).join('/'));
    expect(missing, `call quietGitEnv or useQuietGitProcessEnv (scripts/test-support/quiet-git.mjs): ${missing.join(', ')}`).toEqual([]);
  });

  // 走査が空振りして素通しするのを防ぐ下限と、判定の正規表現が腐っていないことの確認。
  it('still finds the temp repo tests, and tells a quiet one from a forgetful one', () => {
    // src と scripts のどちらかが丸ごと走査から落ちても気づけるよう、下限はディレクトリごとに持つ (bdboard-5py8 時点で src 4 / scripts 8)。
    // 合計の下限 8 だと、scripts だけで 8 に届くので src 側の脱落 (SCAN_DIRS や TEST_FILE の .ts が外れる) を素通しする。
    const countIn = (dir: string): number =>
      gitWriters.filter((file) => path.relative(REPO_ROOT, file).split(path.sep)[0] === dir).length;
    expect(countIn('src')).toBeGreaterThanOrEqual(4);
    expect(countIn('scripts')).toBeGreaterThanOrEqual(8);
    const forgetful = "await git(['init', '-q']);\nawait git(['commit', '-m', 'x']);\n";
    expect(runsGitWrites(forgetful)).toBe(true);
    expect(callsQuietGit(forgetful)).toBe(false);
    expect(callsQuietGit(`import { RM_OPTIONS } from './test-support/quiet-git.mjs';\n${forgetful}`)).toBe(false);
    // 名前を import するだけで呼ばないファイル (import を残して呼び出しだけ外した形) は、呼んでいるとは数えない。
    expect(callsQuietGit(`import { quietGitEnv, useQuietGitProcessEnv } from './test-support/quiet-git.mjs';\n${forgetful}`)).toBe(false);
    expect(callsQuietGit(`useQuietGitProcessEnv();\n${forgetful}`)).toBe(true);
    expect(callsQuietGit(`env = { ...quietGitEnv(home) };\n${forgetful}`)).toBe(true);
    expect(runsGitWrites("expect(args).toContain('commit');\nconst phase = 'init';\n")).toBe(false);
  });

  // コメントだけに残した呼び出しは数えず、文字列の中の `//` や `/*` は壊さない (bdboard-sl0n)。
  it('does not count a quiet-git call that is only in a comment, and keeps a call after a // inside a string', () => {
    const forgetful = "await git(['init', '-q']);\nawait git(['commit', '-m', 'x']);\n";
    expect(callsQuietGit(`// useQuietGitProcessEnv(); は外した\n${forgetful}`)).toBe(false);
    expect(callsQuietGit(`${forgetful}  // env = { ...quietGitEnv(home) };\n`)).toBe(false);
    expect(callsQuietGit(`/* useQuietGitProcessEnv(); */\n${forgetful}`)).toBe(false);
    expect(callsQuietGit(`/**\n * useQuietGitProcessEnv();\n * quietGitEnv(dir)\n */\n${forgetful}`)).toBe(false);
    expect(callsQuietGit(`${forgetful}const note = 1; // useQuietGitProcessEnv();\n`)).toBe(false);
    // 文字列・テンプレートリテラルの中の `//` `/*` は行コメントではない。その後ろの本物の呼び出しは数える。
    expect(callsQuietGit(`const url = 'http://example.invalid'; useQuietGitProcessEnv();\n${forgetful}`)).toBe(true);
    expect(callsQuietGit(`const url = "http://example.invalid"; useQuietGitProcessEnv();\n${forgetful}`)).toBe(true);
    expect(callsQuietGit('const url = `http://example.invalid/${x}`; useQuietGitProcessEnv();\n' + forgetful)).toBe(true);
    expect(callsQuietGit(`const glob = '/*'; useQuietGitProcessEnv();\n${forgetful}`)).toBe(true);
    // コメントを挟んでも、その外の呼び出しは数える。
    expect(callsQuietGit(`/* 保守を止める */ useQuietGitProcessEnv();\n${forgetful}`)).toBe(true);
    // コメントの中だけにある repo の作成・書き込みの引数配列は、選ぶ理由にならない。
    expect(runsGitWrites("// git(['init']); git(['commit']);\n")).toBe(false);
    expect(runsGitWrites("/* git(['init', '-q']);\n git(['push', 'origin']); */\n")).toBe(false);
  });
});
