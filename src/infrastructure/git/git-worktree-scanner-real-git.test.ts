import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NodeCommandRunner } from '../process/node-command-runner.js';
import { createGitWorktreeScanner } from './git-worktree-scanner.js';

/**
 * 実 git を使う結合テスト。パースだけならフェイクで足りるが、
 * 「merge-base 以降のコミット差分 + 未コミット差分の両方が取れる」は git の実挙動
 * (`origin/main...HEAD` の解釈、`status --porcelain -z` の並び) に依存するので、
 * 一時リポジトリで実際に worktree を 2 本作って確かめる。
 */

const runner = new NodeCommandRunner();
const tmpDirs: string[] = [];

/**
 * テスト用の git 実行。利用者の設定に引きずられないようにする:
 * gpg 署名 (commit.gpgsign) が有効な環境では commit がハングまたは失敗し、
 * core.hooksPath にグローバルなフックが刺さっていると勝手に走る。
 */
async function git(args: readonly string[]): Promise<void> {
  const result = await runner.run(
    'git',
    ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args],
    { timeoutMs: 20_000 },
  );
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop()!;
    // 走り終えた git のプロセスがまだファイルを掴んでいることがある
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});

describe('createGitWorktreeScanner.listChangedFiles against a real repository', () => {
  it('reports committed and uncommitted files for two sibling worktrees', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bdboard-overlap-'));
    tmpDirs.push(tmpDir);

    const repoRoot = path.join(tmpDir, 'repo');
    const originPath = path.join(tmpDir, 'origin.git');

    fs.mkdirSync(repoRoot, { recursive: true });
    await git(['init', '--initial-branch=main', repoRoot]);
    await git(['-C', repoRoot, 'config', 'user.name', 'bdboard-test']);
    await git(['-C', repoRoot, 'config', 'user.email', 'test@example.invalid']);

    fs.writeFileSync(path.join(repoRoot, 'shared.ts'), 'export const shared = 1;\n');
    fs.writeFileSync(path.join(repoRoot, 'untouched.ts'), 'export const untouched = 1;\n');
    await git(['-C', repoRoot, 'add', '.']);
    await git(['-C', repoRoot, 'commit', '-m', 'base']);

    await git(['init', '--bare', originPath]);
    await git(['-C', repoRoot, 'remote', 'add', 'origin', originPath]);
    await git(['-C', repoRoot, 'push', '-u', 'origin', 'main']);

    const worktreeA = path.join(repoRoot, '.claude', 'worktrees', 'ticket-a');
    const worktreeB = path.join(repoRoot, '.claude', 'worktrees', 'ticket-b');
    await git(['-C', repoRoot, 'worktree', 'add', '-b', 'bd/ticket-a', worktreeA, 'origin/main']);
    await git(['-C', repoRoot, 'worktree', 'add', '-b', 'bd/ticket-b', worktreeB, 'origin/main']);

    // A: shared.ts をコミット済みで変更 + own-a.ts を未追跡で追加
    fs.writeFileSync(path.join(worktreeA, 'shared.ts'), 'export const shared = 2;\n');
    await git(['-C', worktreeA, 'add', 'shared.ts']);
    await git(['-C', worktreeA, 'commit', '-m', 'a touches shared']);
    fs.writeFileSync(path.join(worktreeA, 'own-a.ts'), 'export const a = 1;\n');

    // B: shared.ts を未コミットのまま変更 (index にも載せない)
    fs.writeFileSync(path.join(worktreeB, 'shared.ts'), 'export const shared = 3;\n');

    const scanner = createGitWorktreeScanner(runner);

    const filesA = await scanner.listChangedFiles(worktreeA);
    const filesB = await scanner.listChangedFiles(worktreeB);

    expect(filesA).toEqual(['own-a.ts', 'shared.ts']);
    expect(filesB).toEqual(['shared.ts']);
    expect(filesA).not.toContain('untouched.ts');

    // worktree はどちらも読むだけ。git status がクリーンな側を汚していないこと
    const statusA = await runner.run('git', ['-C', worktreeA, 'status', '--porcelain'], {
      timeoutMs: 10_000,
    });
    expect(statusA.stdout).toContain('own-a.ts');
    expect(statusA.stdout).not.toContain('shared.ts');

    // 2 回目でも作業ツリーの変更が見えること。コミットも `git add` もしないので
    // index の mtime は動かず、そこをキャッシュキーにしていると取りこぼす。
    fs.writeFileSync(path.join(worktreeB, 'late-edit.ts'), 'export const late = 1;\n');
    fs.mkdirSync(path.join(worktreeB, 'newdir'), { recursive: true });
    fs.writeFileSync(
      path.join(worktreeB, 'newdir', 'inside.ts'),
      'export const inside = 1;\n',
    );

    const filesBAgain = await scanner.listChangedFiles(worktreeB);
    expect(filesBAgain).toContain('late-edit.ts');
    // --untracked-files=all を付けないと 'newdir/' の 1 件に畳まれる
    expect(filesBAgain).toContain('newdir/inside.ts');
    expect(filesBAgain).toContain('shared.ts');
  }, 60_000);
});
