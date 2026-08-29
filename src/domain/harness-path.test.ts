import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  appendGitignoreEntries,
  GITIGNORE_MANAGED_HEADER,
  gitignoreLinesToAppend,
  gitignoreManifestEntry,
  gitignorePackSkillDirEntry,
  isUnderClaudeDir,
  MANIFEST_RELATIVE_PATH,
  normalizeProjectRelativePath,
  resolveUnderClaudeDir,
  skillInstallRelativePath,
  isPathInside,
} from './harness-path.js';

describe('harness-path', () => {
  const projectRoot = '/tmp/example-project';

  it('accepts paths under .claude/', () => {
    expect(isUnderClaudeDir('.claude/bdboard-packs.json')).toBe(true);
    expect(isUnderClaudeDir('.claude/skills/foo/SKILL.md')).toBe(true);
  });

  it('rejects paths outside .claude/', () => {
    expect(isUnderClaudeDir('src/main.ts')).toBe(false);
    expect(isUnderClaudeDir('.beads/issues.jsonl')).toBe(false);
  });

  it('rejects traversal segments', () => {
    expect(normalizeProjectRelativePath('../secret')).toBeNull();
    expect(normalizeProjectRelativePath('.claude/../secret')).toBeNull();
    expect(skillInstallRelativePath('pack', '../escape.md')).toBeNull();
  });

  it('rejects absolute paths', () => {
    expect(normalizeProjectRelativePath('/etc/passwd')).toBeNull();
  });

  it('resolves only within .claude/', () => {
    // resolveUnderClaudeDir はネイティブ絶対パスを返す仕様なので、期待値も path で組む (bdboard-9dm)。
    expect(
      resolveUnderClaudeDir(projectRoot, '.claude/skills/pack/SKILL.md'),
    ).toBe(path.resolve(projectRoot, '.claude', 'skills', 'pack', 'SKILL.md'));
    expect(resolveUnderClaudeDir(projectRoot, 'src/main.ts')).toBeNull();
    expect(
      resolveUnderClaudeDir(projectRoot, '.claude/skills/pack/../../outside'),
    ).toBeNull();
  });

  it('builds skill install paths from pack files', () => {
    expect(skillInstallRelativePath('bdboard-harness', 'SKILL.md')).toBe(
      '.claude/skills/bdboard-harness/SKILL.md',
    );
    expect(skillInstallRelativePath('bdboard-harness', 'references/a.md')).toBe(
      '.claude/skills/bdboard-harness/references/a.md',
    );
  });

  it('builds gitignore entries for manifest and pack skill dir', () => {
    expect(gitignoreManifestEntry()).toBe(MANIFEST_RELATIVE_PATH);
    expect(gitignorePackSkillDirEntry('bdboard-harness')).toBe(
      '.claude/skills/bdboard-harness/',
    );
    expect(gitignorePackSkillDirEntry('../evil')).toBeNull();
  });

  it('appends gitignore lines idempotently', () => {
    const first = appendGitignoreEntries('', 'alpha-pack');
    expect(first).toBe(
      `${GITIGNORE_MANAGED_HEADER}\n${MANIFEST_RELATIVE_PATH}\n.claude/skills/alpha-pack/\n`,
    );

    const second = appendGitignoreEntries(first, 'alpha-pack');
    expect(second).toBe(first);

    const withBeta = appendGitignoreEntries(first, 'beta-pack');
    expect(withBeta).toBe(
      `${GITIGNORE_MANAGED_HEADER}\n${MANIFEST_RELATIVE_PATH}\n.claude/skills/alpha-pack/\n.claude/skills/beta-pack/\n`,
    );
    expect(gitignoreLinesToAppend(withBeta, 'alpha-pack')).toEqual([]);
    expect(gitignoreLinesToAppend(withBeta, 'beta-pack')).toEqual([]);
  });

  it('preserves existing gitignore content when appending', () => {
    const existing = 'node_modules/\ndist/\n';
    const updated = appendGitignoreEntries(existing, 'bdboard-harness');
    expect(updated.startsWith('node_modules/\ndist/\n')).toBe(true);
    expect(updated).toContain(GITIGNORE_MANAGED_HEADER);
    expect(updated).toContain(MANIFEST_RELATIVE_PATH);
    expect(updated).toContain('.claude/skills/bdboard-harness/');
  });

  it('adds newline before append when existing file lacks trailing newline', () => {
    const existing = 'node_modules/';
    const updated = appendGitignoreEntries(existing, 'bdboard-harness');
    expect(updated.startsWith('node_modules/\n')).toBe(true);
  });

  describe('isPathInside (bdboard-x32)', () => {
    it('treats an identical path as inside', () => {
      expect(isPathInside('/repo', '/repo')).toBe(true);
      expect(isPathInside('/repo', '/repo/')).toBe(true);
    });

    it('recognizes a nested path as inside', () => {
      expect(isPathInside('/repo', '/repo/harness/packs')).toBe(true);
    });

    it('rejects a path outside the parent', () => {
      expect(isPathInside('/repo', '/other/harness/packs')).toBe(false);
      expect(isPathInside('/repo/project', '/repo')).toBe(false);
    });

    it('does not mistake a sibling whose name starts with dots for an escape', () => {
      // path.relative('/repo/a', '/repo/..bak') === '../..bak' なので、
      // startsWith('..') だけで見ると外側判定になる。ここは正しく外側。
      expect(isPathInside('/repo/a', '/repo/..bak')).toBe(false);
      // 逆に親の直下に `..bak` がある場合は内側。素朴な startsWith 実装だと
      // relative が '..bak' になり誤って外側に倒れる。
      expect(isPathInside('/repo', '/repo/..bak')).toBe(true);
    });

    it('is not fooled by a prefix-sharing sibling directory', () => {
      expect(isPathInside('/repo', '/repository')).toBe(false);
    });
  });

});
