import { describe, expect, it } from 'vitest';
import {
  isUnderClaudeDir,
  normalizeProjectRelativePath,
  resolveUnderClaudeDir,
  skillInstallRelativePath,
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
    expect(
      resolveUnderClaudeDir(projectRoot, '.claude/skills/pack/SKILL.md'),
    ).toBe('/tmp/example-project/.claude/skills/pack/SKILL.md');
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
});
