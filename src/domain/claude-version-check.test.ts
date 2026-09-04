import { describe, expect, it } from 'vitest';
import {
  compareClaudeVersions,
  describeClaudeSettingSourcesFailure,
  evaluateClaudeVersion,
  MINIMUM_CLAUDE_VERSION,
  parseClaudeVersion,
} from './claude-version-check.js';

describe('parseClaudeVersion', () => {
  it('extracts semver from claude --version output', () => {
    expect(parseClaudeVersion('2.1.233 (Claude Code)')).toBe('2.1.233');
  });

  it('trims surrounding whitespace', () => {
    expect(parseClaudeVersion('  2.1.233 (Claude Code)  ')).toBe('2.1.233');
  });

  it('preserves prerelease identifiers', () => {
    expect(parseClaudeVersion('2.1.233-rc.1 (Claude Code)')).toBe('2.1.233-rc.1');
  });

  it('returns null for empty or missing input', () => {
    expect(parseClaudeVersion('')).toBeNull();
    expect(parseClaudeVersion(null)).toBeNull();
    expect(parseClaudeVersion(undefined)).toBeNull();
  });

  it('returns null when no semver is present', () => {
    expect(parseClaudeVersion('Claude Code')).toBeNull();
  });
});

describe('compareClaudeVersions', () => {
  it('returns 0 for equal versions', () => {
    expect(compareClaudeVersions('2.1.233', '2.1.233')).toBe(0);
  });

  it('returns negative when the first version is older', () => {
    expect(compareClaudeVersions('2.1.232', '2.1.233')).toBeLessThan(0);
    expect(compareClaudeVersions('2.0.999', '2.1.233')).toBeLessThan(0);
    expect(compareClaudeVersions('1.9.9', '2.1.233')).toBeLessThan(0);
  });

  it('returns positive when the first version is newer', () => {
    expect(compareClaudeVersions('2.1.234', '2.1.233')).toBeGreaterThan(0);
    expect(compareClaudeVersions('2.2.0', '2.1.233')).toBeGreaterThan(0);
    expect(compareClaudeVersions('3.0.0', '2.1.233')).toBeGreaterThan(0);
  });

  it('compares numeric patch segments numerically, not lexicographically', () => {
    expect(compareClaudeVersions('2.1.99', '2.1.233')).toBeLessThan(0);
  });

  it('orders prerelease versions before release versions', () => {
    expect(compareClaudeVersions('2.1.233-rc.1', '2.1.233')).toBeLessThan(0);
    expect(compareClaudeVersions('2.1.233-rc.1', '2.1.233-rc.2')).toBeLessThan(0);
    expect(compareClaudeVersions('2.1.233-alpha', '2.1.233-beta')).toBeLessThan(0);
  });
});

describe('evaluateClaudeVersion', () => {
  it('returns supported when the version meets the minimum', () => {
    const result = evaluateClaudeVersion('2.1.233 (Claude Code)');

    expect(result.status).toBe('supported');
    expect(result.version).toBe('2.1.233');
  });

  it('returns too-old with both detected and minimum versions in the message', () => {
    const result = evaluateClaudeVersion('2.0.10 (Claude Code)');

    expect(result.status).toBe('too-old');
    expect(result.version).toBe('2.0.10');
    expect(result.message).toContain('2.0.10');
    expect(result.message).toContain(MINIMUM_CLAUDE_VERSION);
    expect(result.message).toContain('--setting-sources');
  });

  it('returns unknown without blocking when the version cannot be parsed', () => {
    const result = evaluateClaudeVersion('not-a-version');

    expect(result.status).toBe('unknown');
    expect(result.version).toBeNull();
    expect(result.message).toContain(MINIMUM_CLAUDE_VERSION);
    expect(result.message).toContain('--setting-sources');
  });
});

describe('describeClaudeSettingSourcesFailure', () => {
  it('returns a translated message when stderr rejects --setting-sources', () => {
    const message = describeClaudeSettingSourcesFailure(
      "error: unknown option '--setting-sources'",
    );

    expect(message).not.toBeNull();
    expect(message).toContain(MINIMUM_CLAUDE_VERSION);
    expect(message).toContain('--setting-sources');
  });

  it('returns null for unrelated stderr', () => {
    expect(describeClaudeSettingSourcesFailure('ENOENT')).toBeNull();
    expect(describeClaudeSettingSourcesFailure('permission denied')).toBeNull();
    expect(
      describeClaudeSettingSourcesFailure('unknown option --permission-mode'),
    ).toBeNull();
  });
});
