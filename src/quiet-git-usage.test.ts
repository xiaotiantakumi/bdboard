// bdboard-5py8 (M1): 一時 git repo を作って commit / fetch / push するテストが、git の自動保守を止める補助
// (scripts/test-support/quiet-git.mjs) を使っているかの静的な検査。外し忘れ・付け忘れは、テストが緑のまま
// `git maintenance run --auto --detach` の起動が残り、後始末の rmSync と競合して ENOTEMPTY になる (bdboard-w8hr)。
// 全テストに効く vitest の setupFiles は影響が大きいので入れず、ここでは文字列の走査に留める。
// 判定はテスト/補助ファイルの本文だけを見る: repo を作る (`'init'` が引数配列の要素) ＋ 保守を起こす書き込み
// (`'commit'` / `'fetch'` / `'push'` が引数配列の要素) の両方があれば、quiet-git の補助を呼んでいること。
// import だけ残して呼び出しを外した (RM_OPTIONS だけ使っている) 場合も落とすため、import ではなく呼び出しを見る。
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

const runsGitWrites = (source: string): boolean => CREATES_REPO.test(source) && WRITES_REPO.test(source);
const callsQuietGit = (source: string): boolean => CALLS_QUIET_GIT.test(source);

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
    expect(gitWriters.length).toBeGreaterThanOrEqual(8);
    const forgetful = "await git(['init', '-q']);\nawait git(['commit', '-m', 'x']);\n";
    expect(runsGitWrites(forgetful)).toBe(true);
    expect(callsQuietGit(forgetful)).toBe(false);
    expect(callsQuietGit(`import { RM_OPTIONS } from './test-support/quiet-git.mjs';\n${forgetful}`)).toBe(false);
    expect(callsQuietGit(`useQuietGitProcessEnv();\n${forgetful}`)).toBe(true);
    expect(callsQuietGit(`env = { ...quietGitEnv(home) };\n${forgetful}`)).toBe(true);
    expect(runsGitWrites("expect(args).toContain('commit');\nconst phase = 'init';\n")).toBe(false);
  });
});
