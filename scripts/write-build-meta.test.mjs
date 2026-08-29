import { describe, expect, it } from 'vitest';
import { buildMetaJson, resolveBuildSha } from './write-build-meta.mjs';

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
