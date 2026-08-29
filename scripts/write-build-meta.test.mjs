import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { buildMetaJson, resolveBuildSha } from './write-build-meta.mjs';

const SOURCE_SCRIPT_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'write-build-meta.mjs',
);

describe('resolveBuildSha', () => {
  it('prefers GITHUB_SHA over BDBOARD_BUILD_SHA and over git', () => {
    const sha = resolveBuildSha(
      { GITHUB_SHA: 'from-github', BDBOARD_BUILD_SHA: 'from-env' },
      () => 'from-git',
    );
    expect(sha).toBe('from-github');
  });

  it('falls back to BDBOARD_BUILD_SHA when GITHUB_SHA is absent', () => {
    const sha = resolveBuildSha({ BDBOARD_BUILD_SHA: 'from-env' }, () => 'from-git');
    expect(sha).toBe('from-env');
  });

  it('ignores an empty-string env var and falls through to git', () => {
    const sha = resolveBuildSha({ GITHUB_SHA: '' }, () => 'from-git');
    expect(sha).toBe('from-git');
  });

  it('falls back to git when no env var is set', () => {
    const sha = resolveBuildSha({}, () => 'from-git');
    expect(sha).toBe('from-git');
  });

  it('returns null when git also fails (e.g. shallow clone / no .git)', () => {
    const sha = resolveBuildSha({}, () => {
      throw new Error('fatal: not a git repository');
    });
    expect(sha).toBeNull();
  });
});

describe('buildMetaJson', () => {
  it('serializes sha and builtAt as pretty JSON with a trailing newline', () => {
    const json = buildMetaJson('abc123', '2026-08-20T00:00:00.000Z');
    expect(json).toBe('{\n  "sha": "abc123",\n  "builtAt": "2026-08-20T00:00:00.000Z"\n}\n');
    expect(JSON.parse(json)).toEqual({ sha: 'abc123', builtAt: '2026-08-20T00:00:00.000Z' });
  });

  it('serializes a null sha as JSON null (not the string "null")', () => {
    const json = buildMetaJson(null, '2026-08-20T00:00:00.000Z');
    expect(JSON.parse(json).sha).toBeNull();
  });
});

describe('isMain (direct-execution detection)', () => {
  let scratchDir;

  afterEach(() => {
    if (scratchDir !== undefined) {
      rmSync(scratchDir, { recursive: true, force: true });
      scratchDir = undefined;
    }
  });

  it('runs even when the repository path contains a space or non-ASCII characters', () => {
    // 回帰テスト(bdboard-kd1j): import.meta.url は空白を %20 に、非ASCIIをパーセント
    // エンコードして持つが、process.argv[1] は生パスなので、`file://${process.argv[1]}`
    // という単純な文字列比較では両者が一致せず、直接実行しても main() が無言でスキップ
    // されていた(exit 0 のまま何も書かない)。
    // realpathSync: macOS の /tmp は /private/tmp のシンボリックリンクなので、解決
    // しておかないと import.meta.url(realpath 側)と process.argv[1](生パス側)が
    // 空白/非ASCIIとは無関係な理由でずれ、このテストの意図(空白/非ASCII固有の再現)
    // から外れてしまう。
    scratchDir = realpathSync(mkdtempSync(path.join(tmpdir(), 'bdboard-kd1j-')));
    const spacedRoot = path.join(scratchDir, 'has space and 日本語');
    mkdirSync(path.join(spacedRoot, 'scripts'), { recursive: true });
    const copiedScriptPath = path.join(spacedRoot, 'scripts', 'write-build-meta.mjs');
    copyFileSync(SOURCE_SCRIPT_PATH, copiedScriptPath);

    // スクリプトの REPO_ROOT は import.meta.url(=自身の配置場所)から解決するので、
    // cwd ではなく実際にスクリプトファイルを空白/非ASCII入りパスへ複製して実行する
    // 必要がある — これでこそ import.meta.url がエンコード済みになり、修正前の
    // `file://${process.argv[1]}` 単純比較が壊れていた状況を再現できる。
    const stdout = execFileSync(process.execPath, [copiedScriptPath], {
      encoding: 'utf8',
    });

    expect(stdout).toMatch(/^Wrote .*build-meta\.json \(sha=/);
    const metaPath = path.join(spacedRoot, 'web', 'dist', 'build-meta.json');
    const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
    expect(meta).toHaveProperty('sha');
    expect(meta).toHaveProperty('builtAt');
  });
});
