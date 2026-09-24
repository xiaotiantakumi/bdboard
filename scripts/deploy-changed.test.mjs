// bdboard-cdoj: scripts/deploy-changed.sh の deploy 再起動判定を単体テストする。
// 一時 Git リポジトリでコミットを重ね、スクリプトを直接実行して確認する。
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = fileURLToPath(new URL('./deploy-changed.sh', import.meta.url));

function hasGit() {
  return spawnSync('git', ['--version']).status === 0;
}

describe.skipIf(process.platform === 'win32' || !hasGit())('deploy-changed.sh', () => {
  let tmpRoot;
  let repo;

  function git(...args) {
    const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
    if (result.status !== 0) {
      throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
    }
    return result.stdout;
  }

  function commit(message) {
    git('add', '-A');
    git(
      '-c', 'user.name=bdboard-test',
      '-c', 'user.email=bdboard-test@example.invalid',
      '-c', 'commit.gpgsign=false',
      'commit', '-q', '-m', message,
    );
    return git('rev-parse', 'HEAD').trim();
  }

  function relevantChanged(oldSha, newSha, ...paths) {
    const result = spawnSync('bash', [SCRIPT, repo, oldSha, newSha, '--', ...paths], {
      encoding: 'utf8',
      timeout: 10_000,
    });
    return result.status === 0;
  }

  beforeEach(() => {
    tmpRoot = mkdtempSync(path.join(tmpdir(), 'bdboard-deploy-changed-'));
    repo = path.join(tmpRoot, 'repo');
    mkdirSync(path.join(repo, 'src'), { recursive: true });
    writeFileSync(path.join(repo, 'src', 'index.ts'), 'export const a = 1;\n');
    writeFileSync(path.join(repo, 'package.json'), '{"name":"fake"}\n');
    git('init', '-q');
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('reports no relevant change when OLD and NEW are the same commit', () => {
    const head = commit('init');
    expect(relevantChanged(head, head, 'src/', 'package.json', 'package-lock.json', '.env')).toBe(
      false,
    );
  });

  it('excludes test files and test-only directories', () => {
    const oldSha = commit('init');
    mkdirSync(path.join(repo, 'src', '__fixtures__'), { recursive: true });
    mkdirSync(path.join(repo, 'src', 'foo-test-support'), { recursive: true });
    writeFileSync(path.join(repo, 'src', 'a.test.ts'), '// test\n');
    writeFileSync(path.join(repo, 'src', 'b.test.mjs'), '// test\n');
    writeFileSync(path.join(repo, 'src', 'c.test.tsx'), '// test\n');
    writeFileSync(path.join(repo, 'src', '__fixtures__', 'sample.ts'), 'export const x = 1;\n');
    writeFileSync(path.join(repo, 'src', 'foo-test-support', 'helper.ts'), 'export const y = 1;\n');
    const newSha = commit('test-only change');
    expect(
      relevantChanged(oldSha, newSha, 'src/', 'package.json', 'package-lock.json', '.env'),
    ).toBe(false);
  });

  it('reports a relevant change when a real src/ file changes alongside test files', () => {
    const oldSha = commit('init');
    writeFileSync(path.join(repo, 'src', 'index.ts'), 'export const a = 2;\n');
    writeFileSync(path.join(repo, 'src', 'a.test.ts'), '// test\n');
    const newSha = commit('real change with test');
    expect(
      relevantChanged(oldSha, newSha, 'src/', 'package.json', 'package-lock.json', '.env'),
    ).toBe(true);
  });

  it('reports a relevant change when package.json changes', () => {
    const oldSha = commit('init');
    writeFileSync(path.join(repo, 'package.json'), '{"name":"fake","version":"2.0.0"}\n');
    const newSha = commit('bump version');
    expect(
      relevantChanged(oldSha, newSha, 'src/', 'package.json', 'package-lock.json', '.env'),
    ).toBe(true);
  });
});
